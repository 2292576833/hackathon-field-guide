import { randomUUID } from "node:crypto";
import type { Clock, IdGenerator } from "../shared/contracts.ts";
import type { DatabasePort } from "../shared/persistence.ts";
import { DomainError } from "../shared/errors.ts";
import { AuthService, PostgresAuthStore, createNodeAuthCrypto, normalizeLoginEmail } from "../modules/auth/index.ts";

export interface AdminTestAccess {
  /** A short-lived, single-use challenge and code, never a session token. */
  readonly credential: string;
  readonly challengeId: string;
  readonly email: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}
export interface AdminTestAccessOptions {
  readonly database: DatabasePort;
  readonly codePepper: string;
  readonly email: unknown;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly globalSendLimit?: number;
}

/** Trusted offline CLI only. Never mount this function on an HTTP route.
 * The caller must own the embedded database exclusively. Existing public auth
 * consumes the challenge and applies its normal session lifetime and roles. */
export async function issueAdminTestAccess(options: AdminTestAccessOptions): Promise<AdminTestAccess> {
  const email = normalizeLoginEmail(options.email);
  const clock = options.clock ?? { now: () => new Date() };
  const ids = options.ids ?? { next: () => randomUUID() };
  const crypto = createNodeAuthCrypto(options.codePepper);
  return options.database.transaction(async sql => {
    // Match M01's email -> account lock order. The store's repeated advisory
    // lock is reentrant within this same transaction, including connected pg.
    await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`auth-email:${email}`]);
    const accounts = await sql.query<{ id: string; status: string; platform_roles: string[]; email_verified_at: string | Date | null }>(
      "SELECT id,status,platform_roles,email_verified_at FROM auth_users WHERE email=$1 FOR UPDATE", [email],
    );
    const account = accounts.rows[0];
    if (!account || account.status !== "active" || !account.email_verified_at || !account.platform_roles.includes("admin")) {
      throw new DomainError("ADMIN_TEST_ACCESS_DENIED", "只能为已验证且有效的现有管理员账号签发测试凭证。", { status: 403 });
    }
    let captured: { email: string; code: string; expiresAt: string } | null = null;
    const auth = new AuthService({
      store: new PostgresAuthStore(options.database, ids, clock), crypto, clock, ids,
      // The privileged CLI takes local custody instead of contacting an email
      // provider. Its file/UI must say explicitly that no email was sent.
      email: { async sendLoginCode(input) {
        if (captured !== null || input.email !== email || !/^[0-9]{8}$/.test(input.code)) {
          throw new Error("ADMIN_TEST_ACCESS_CAPTURE_INVALID");
        }
        captured = { ...input };
      } },
      policy: { maxSendsPerClient: options.globalSendLimit ?? 20 },
    });
    const receipt = await auth.requestLoginChallenge(email, "trusted-cli-admin-test-access");
    const local = captured as { email: string; code: string; expiresAt: string } | null;
    const saved = (await sql.query<{ email: string; code_hash: string; created_at: string | Date; expires_at: string | Date; delivery: string; consumed_at: string | Date | null; revoked_at: string | Date | null }>(
      "SELECT email,code_hash,created_at,expires_at,delivery,consumed_at,revoked_at FROM auth_login_challenges WHERE id=$1", [receipt.challengeId],
    )).rows[0];
    if (!local || !saved || local.email !== saved.email || local.email !== email
      || local.expiresAt !== receipt.expiresAt || new Date(saved.expires_at).toISOString() !== receipt.expiresAt
      || saved.code_hash !== crypto.hashCode(receipt.challengeId, local.code)
      || saved.delivery !== "ready" || saved.consumed_at !== null || saved.revoked_at !== null
      || Date.parse(receipt.expiresAt) <= clock.now().getTime()) {
      throw new DomainError("ADMIN_TEST_ACCESS_UNAVAILABLE", "本次测试凭证未能完成签发，请稍后重试。", { status: 503 });
    }
    await sql.query(
      "INSERT INTO auth_audit_events(id,actor_id,action,object_type,object_id,result,occurred_at) VALUES($1,$2,'trusted_cli_test_challenge','challenge',$3,'issued_locally',$4)",
      [ids.next(), account.id, receipt.challengeId, clock.now().toISOString()],
    );
    return { credential: `${receipt.challengeId}.${local.code}`, challengeId: receipt.challengeId, email,
      issuedAt: new Date(saved.created_at).toISOString(), expiresAt: receipt.expiresAt };
  });
}
