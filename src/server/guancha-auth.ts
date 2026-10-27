import { createHash, timingSafeEqual } from "node:crypto";
import type { Clock, IdGenerator } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import { DomainError } from "../shared/errors.ts";
import {
  DEFAULT_AUTH_POLICY, safeAuthReturnTo,
  type AuthCryptoPort, type SessionGrant, type UserProfile,
} from "../modules/auth/index.ts";
import type { GuanchaIdentityPort, GuanchaVerifiedIdentity } from "../modules/guancha-login/index.ts";

/** Server-only result. Tokens belong in HttpOnly cookies, never public JSON. */
export type GuanchaAuthResult =
  | { readonly status: "authenticated"; readonly grant: SessionGrant }
  | { readonly status: "link_required"; readonly pendingToken: string; readonly expiresAt: string; readonly returnTo: string };

export interface GuanchaAuthDependencies {
  readonly database: DatabasePort;
  readonly crypto: AuthCryptoPort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly pendingLifetimeMs?: number;
  readonly sessionLifetimeMs?: number;
  readonly recentAuthenticationMs?: number;
  /** 下载观猹头像（含白名单与字节校验）；缺省时不做头像继承。 */
  readonly fetchAvatar?: (url: string) => Promise<{ readonly mimeType: "image/png" | "image/jpeg" | "image/webp"; readonly base64: string } | null>;
  /** 把头像写进本站既有头像存储（招募档案）。缺省时不做头像继承。 */
  readonly saveAvatar?: (userId: string, avatar: { readonly mimeType: "image/png" | "image/jpeg" | "image/webp"; readonly base64: string }) => Promise<void>;
}

export interface GuanchaConfirmLinkInput {
  /** All three values must be read by the root handler from its cookie boundary. */
  readonly pendingToken: string | null | undefined;
  readonly browserBinding: string | null | undefined;
  readonly sessionToken: string | null | undefined;
}

export interface GuanchaAuth extends GuanchaIdentityPort<GuanchaAuthResult> {
  /** Root invokes only after an explicit, same-origin POST confirmation. */
  confirmLink(input: GuanchaConfirmLinkInput): Promise<{
    readonly success: true;
    readonly returnTo: string;
    /** 待继承的观猹资料：昵称已校验可直接使用；头像地址仍需下载并做字节校验。 */
    readonly profileSync: { readonly displayName: string | null; readonly avatarUrl: string | null };
  }>;

  /**
   * 同步已关联账号的观猹资料：首次可把观猹昵称设为默认昵称，并把观猹头像存进本站头像。
   *
   * 约定：**只在首次成功关联时调用**（绑定已存在时不会再调），因此观猹昵称不会覆盖
   * 用户在站内自行修改过的名字。任何一步失败都只记录、不抛出——头像或昵称拿不到
   * 绝不能让登录失败。
   */
  syncLinkedProfile(userId: string, sync: { readonly displayName: string | null; readonly avatarUrl: string | null }): Promise<void>;
}

type Timestamp = string | Date;
interface UserRow {
  id: string; email: string; display_name: string; timezone: string; status: string;
  email_verified_at: Timestamp | null; revision: number;
}
interface SessionRow {
  id: string; user_id: string; created_at: Timestamp; authenticated_at: Timestamp;
  expires_at: Timestamp; revoked_at: Timestamp | null;
}
interface PendingRow {
  token_hash: string; browser_binding_hash: string; issuer: string; subject: string;
  return_to: string; created_at: Timestamp; expires_at: Timestamp; consumed_at: Timestamp | null;
  avatar_url: string | null; display_name: string | null;
}

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const time = (value: Timestamp) => new Date(value).getTime();
const validToken = (value: unknown): value is string => typeof value === "string" && tokenPattern.test(value);
const invalidLink = () => new DomainError("GUANCHA_LINK_INVALID", "本次关联已失效，请重新发起观猹登录。", { status: 400 });
const sessionRequired = () => new DomainError("AUTH_SESSION_REQUIRED", "登录已失效，请先使用邮箱验证码登录。", { status: 401 });
const conflict = () => new DomainError("GUANCHA_LINK_CONFLICT", "当前账号无法完成这次关联，请检查已关联账号后重新操作。", { status: 409 });
const recentRequired = () => new DomainError("AUTH_REAUTHENTICATION_REQUIRED", "关联前请重新验证邮箱并登录。", { status: 403, recoveryAction: "reauthenticate" });

function sameHash(left: string, right: string): boolean {
  return hashPattern.test(left) && hashPattern.test(right) && timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function validIdentity(identity: GuanchaVerifiedIdentity): boolean {
  if (!identity || typeof identity.issuer !== "string" || identity.issuer.length > 2048
      || /[\u0000-\u0020\u007f\\]/.test(identity.issuer)
      || typeof identity.subject !== "string" || !identity.subject.length || identity.subject.length > 512
      || /[\u0000-\u0020\u007f]/.test(identity.subject)) return false;
  try {
    const url = new URL(identity.issuer);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

/** 观猹昵称只作为**默认昵称**候选：超长或含控制字符一律丢弃，不报错。 */
export function usableGuanchaName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 60) return null;
  return /[\u0000-\u001f\u007f]/.test(trimmed) ? null : trimmed;
}

function profile(user: UserRow): UserProfile {
  return {
    id: user.id, email: user.email, displayName: user.display_name, timezone: user.timezone,
    emailVerifiedAt: new Date(user.email_verified_at!).toISOString(), revision: user.revision,
  };
}

/** No provider I/O and no environment access. Never creates or modifies an M01
 * user, imports provider email, or selects an account by name/email.
 * Lock order: exact identity advisory lock -> user -> session -> pending link.
 * Email locks are unnecessary because this adapter never changes an email/user.
 */
export function createGuanchaAuth(deps: GuanchaAuthDependencies): GuanchaAuth {
  const pendingLifetimeMs = deps.pendingLifetimeMs ?? 10 * 60_000;
  const sessionLifetimeMs = deps.sessionLifetimeMs ?? DEFAULT_AUTH_POLICY.sessionLifetimeMs;
  const recentAuthenticationMs = deps.recentAuthenticationMs ?? DEFAULT_AUTH_POLICY.recentAuthenticationMs;
  if (![pendingLifetimeMs, sessionLifetimeMs, recentAuthenticationMs].every(value => Number.isSafeInteger(value) && value > 0)
      || pendingLifetimeMs > 15 * 60_000) throw new Error("Invalid Guancha authentication lifetimes.");

  const lockIdentity = (sql: SqlExecutor, issuer: string, subject: string) => sql.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`guancha-identity:${JSON.stringify([issuer, subject])}`],
  );
  const audit = (sql: SqlExecutor, actorId: string | null, action: string, result: string, now: string) => sql.query(
    `INSERT INTO auth_audit_events(id,actor_id,action,object_type,object_id,result,occurred_at)
     VALUES($1,$2,$3,'guancha_identity',$4,$5,$6)`,
    [deps.ids.next(), actorId, action, deps.ids.next(), result, now],
  );
  const randomToken = () => {
    const value = deps.crypto.generateSessionToken();
    if (!validToken(value)) throw new Error("Invalid generated authentication token.");
    return value;
  };

  /**
   * 首次关联成功后继承观猹资料。**任何失败都只记录、不抛出**：
   * 头像或昵称拿不到只是"少了个头像"，绝不能让一次已经成功的关联登录失败。
   */
  async function syncLinkedProfile(userId: string, sync: { readonly displayName: string | null; readonly avatarUrl: string | null }): Promise<void> {
    try {
      const name = usableGuanchaName(sync.displayName);
      if (name) {
        // 只作为"默认昵称"：仅在账号昵称**从未被用户自己改过**时采用观猹昵称，
        // 并把标记置为已定，之后（含本函数再次调用）都不再改动。
        // 不能用"昵称是否等于某个默认值"来猜——注册默认值与用户可能取的名字都可能撞上。
        await deps.database.query(
          `UPDATE auth_users SET display_name=$2, display_name_customized=true, revision=revision+1
           WHERE id=$1 AND display_name_customized=false AND display_name <> $2`,
          [userId, name],
        );
      }
      if (!sync.avatarUrl || !deps.saveAvatar || !deps.fetchAvatar) return;
      const downloaded = await deps.fetchAvatar(sync.avatarUrl);
      if (!downloaded) return;
      await deps.saveAvatar(userId, downloaded);
    } catch { /* 继承失败不影响登录本身 */ }
  }

  return {
    async completeLogin(input) {
      if (!validIdentity(input.identity) || !hashPattern.test(input.browserBindingHash)
          || !Number.isFinite(Date.parse(input.now))) throw invalidLink();
      const { issuer, subject } = input.identity;
      const returnTo = safeAuthReturnTo(input.returnTo);
      const outcome = await deps.database.transaction(async sql => {
        await lockIdentity(sql, issuer, subject);
        const binding = (await sql.query<{ user_id: string }>(
          "SELECT user_id FROM guancha_identity_bindings WHERE issuer=$1 AND subject=$2", [issuer, subject],
        )).rows[0];
        if (!binding) {
          const pendingToken = randomToken(), now = deps.clock.now().toISOString();
          const expiresAt = new Date(Date.parse(now) + pendingLifetimeMs).toISOString();
          // 观猹昵称/头像地址随待关联记录一起保存：用户去验证邮箱期间不能丢，
          // 否则"确认关联"时已经没有来源可以继承。两者都可空（观猹可能不返回）。
          const avatarUrl = typeof input.identity.avatarUrl === "string" && input.identity.avatarUrl.length <= 2048 ? input.identity.avatarUrl : null;
          const displayName = typeof input.identity.displayName === "string" && input.identity.displayName.length <= 60 ? input.identity.displayName : null;
          await sql.query(
            `INSERT INTO guancha_pending_links(token_hash,browser_binding_hash,issuer,subject,return_to,created_at,expires_at,avatar_url,display_name)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [hash(pendingToken), input.browserBindingHash, issuer, subject, returnTo, now, expiresAt, avatarUrl, displayName],
          );
          await audit(sql, null, "guancha_link_requested", "pending", now);
          return { status: "link_required", pendingToken, expiresAt, returnTo } as const;
        }
        const user = (await sql.query<UserRow>("SELECT * FROM auth_users WHERE id=$1 FOR UPDATE", [binding.user_id])).rows[0];
        const now = deps.clock.now().toISOString();
        if (!user || user.status !== "active" || !user.email_verified_at) {
          await audit(sql, binding.user_id, "guancha_login", "denied", now);
          return { status: "denied" } as const;
        }
        const sessionToken = randomToken(), expiresAt = new Date(Date.parse(now) + sessionLifetimeMs).toISOString();
        const sessionHash = deps.crypto.hashSessionToken(sessionToken);
        if (!hashPattern.test(sessionHash)) throw new Error("Invalid session hash.");
        await sql.query(
          `INSERT INTO auth_sessions(id,user_id,token_hash,created_at,authenticated_at,expires_at,last_seen_at)
           VALUES($1,$2,$3,$4,$4,$5,$4)`, [deps.ids.next(), user.id, sessionHash, now, expiresAt],
        );
        await audit(sql, user.id, "guancha_login", "succeeded", now);
        return { status: "authenticated", grant: { sessionToken, expiresAt, profile: profile(user), returnTo } } as const;
      });
      if (outcome.status === "denied") {
        throw new DomainError("GUANCHA_ACCOUNT_UNAVAILABLE", "当前账号无法登录，请检查账号状态。", { status: 403 });
      }
      return outcome;
    },

    async confirmLink(input) {
      if (!input || Object.keys(input).some(key => !["pendingToken", "browserBinding", "sessionToken"].includes(key))
          || !validToken(input.pendingToken) || !validToken(input.browserBinding)) throw invalidLink();
      if (!validToken(input.sessionToken)) throw sessionRequired();
      const tokenHash = hash(input.pendingToken), browserHash = hash(input.browserBinding);
      const sessionHash = deps.crypto.hashSessionToken(input.sessionToken);
      return deps.database.transaction(async sql => {
        // Hints only: authoritative facts are reread under locks below.
        const hint = (await sql.query<PendingRow>("SELECT * FROM guancha_pending_links WHERE token_hash=$1", [tokenHash])).rows[0];
        if (!hint || !sameHash(hint.browser_binding_hash, browserHash)) throw invalidLink();
        await lockIdentity(sql, hint.issuer, hint.subject);
        const sessionHint = (await sql.query<{ user_id: string }>("SELECT user_id FROM auth_sessions WHERE token_hash=$1", [sessionHash])).rows[0];
        if (!sessionHint) throw sessionRequired();
        const user = (await sql.query<UserRow>("SELECT * FROM auth_users WHERE id=$1 FOR UPDATE", [sessionHint.user_id])).rows[0];
        if (!user || user.status !== "active" || !user.email_verified_at) throw sessionRequired();
        const session = (await sql.query<SessionRow>("SELECT * FROM auth_sessions WHERE token_hash=$1 FOR UPDATE", [sessionHash])).rows[0];
        const pending = (await sql.query<PendingRow>("SELECT * FROM guancha_pending_links WHERE token_hash=$1 FOR UPDATE", [tokenHash])).rows[0];
        const now = deps.clock.now().toISOString();
        const assertCurrent = () => {
          const actual = deps.clock.now().getTime();
          if (!session || session.user_id !== user.id || session.revoked_at !== null
              || time(session.created_at) > actual || time(session.expires_at) <= actual) throw sessionRequired();
          // M01 presently stores no authentication-method claim. This preserves
          // its recent-auth semantics for every M01 session, including Guancha.
          if (time(session.authenticated_at) > actual || time(session.authenticated_at) < actual - recentAuthenticationMs) throw recentRequired();
          if (!pending || pending.issuer !== hint.issuer || pending.subject !== hint.subject
              || !sameHash(pending.browser_binding_hash, browserHash) || pending.consumed_at !== null
              || time(pending.created_at) > actual || time(pending.expires_at) <= actual) throw invalidLink();
        };
        assertCurrent();
        const inserted = await sql.query<{ user_id: string }>(
          `INSERT INTO guancha_identity_bindings(issuer,subject,user_id,created_at)
           VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING user_id`, [hint.issuer, hint.subject, user.id, now],
        );
        if (inserted.rowCount !== 1) throw conflict();
        assertCurrent();
        const consumedAt = deps.clock.now().toISOString();
        const consumed = await sql.query(
          `UPDATE guancha_pending_links SET consumed_at=$2
           WHERE token_hash=$1 AND consumed_at IS NULL AND created_at <= $2 AND expires_at > $2 RETURNING token_hash`,
          [tokenHash, consumedAt],
        );
        if (consumed.rowCount !== 1) throw invalidLink();
        await sql.query("UPDATE auth_sessions SET last_seen_at=GREATEST(last_seen_at,$2::timestamptz) WHERE id=$1", [session!.id, consumedAt]);
        await audit(sql, user.id, "guancha_link_confirmed", "succeeded", consumedAt);
        // Reject expiry or a lapsed recent-auth window while awaiting writes too.
        // The locked snapshots retain their pre-consumption values here.
        assertCurrent();
        // 把观猹昵称与头像地址交回 HTTP 层：昵称已完成校验、只作为首次默认值；
        // 头像仍需下载并按字节校验，不能在这个事务里做外部请求。
        return { success: true, returnTo: safeAuthReturnTo(pending!.return_to),
          profileSync: { displayName: pending!.display_name, avatarUrl: pending!.avatar_url } };
      });
    },
    syncLinkedProfile,
  };
}
