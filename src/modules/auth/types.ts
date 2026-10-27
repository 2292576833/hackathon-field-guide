import type { Actor, PlatformRole } from "../../shared/contracts.ts";

export type AccountStatus = "active" | "suspended" | "deletion_pending" | "deleted";
export type ChallengeDelivery = "pending" | "ready" | "failed";

/** Private persistence records must never be serialized as an API response. */
export interface AuthUserRecord {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly timezone: string;
  readonly status: AccountStatus;
  readonly platformRoles: readonly PlatformRole[];
  readonly emailVerifiedAt: string;
  readonly createdAt: string;
  readonly revision: number;
}

export interface UserProfile {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly timezone: string;
  readonly emailVerifiedAt: string;
  readonly revision: number;
}

export interface LoginChallengeRecord {
  readonly id: string;
  readonly email: string;
  readonly codeHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly delivery: ChallengeDelivery;
  readonly failedAttempts: number;
  readonly consumedAt: string | null;
  readonly revokedAt: string | null;
  /** Unverified registration input; only used when atomically creating a new account. */
  readonly registrationDisplayName?: string | null;
}

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly createdAt: string;
  readonly authenticatedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly lastSeenAt: string;
}

export interface SessionContext {
  readonly user: AuthUserRecord;
  readonly session: SessionRecord;
}

export interface SessionSummary {
  readonly id: string;
  readonly createdAt: string;
  readonly authenticatedAt: string;
  readonly expiresAt: string;
  readonly current: boolean;
  readonly lastSeenAt: string;
}

export interface AccountSettings {
  readonly profile: UserProfile;
  readonly currentSession: SessionSummary;
  readonly sessions: readonly SessionSummary[];
  readonly recentAuthenticationUntil: string;
  readonly canLogoutAll: boolean;
}

/** Private atomic read for account settings; service projects only public metadata. */
export interface OwnAccountSnapshot {
  readonly user: AuthUserRecord;
  readonly currentSession: SessionRecord;
  readonly sessions: readonly SessionSummary[];
}

export interface SessionRevocationReceipt {
  readonly revoked: boolean;
  readonly currentSessionRevoked: boolean;
}

export interface LoginChallengeReceipt {
  readonly challengeId: string;
  readonly expiresAt: string;
  readonly resendAfterSeconds: number;
  readonly message: string;
}

/** Server-only grant: the handler places sessionToken in an HttpOnly cookie. */
export interface SessionGrant {
  readonly sessionToken: string;
  readonly expiresAt: string;
  readonly profile: UserProfile;
  readonly returnTo: string;
}

export interface ProfileUpdate {
  readonly displayName: string;
  readonly timezone: string;
  readonly expectedRevision: number;
}

export interface AuthPolicy {
  readonly challengeLifetimeMs: number;
  readonly sessionLifetimeMs: number;
  readonly sendCooldownMs: number;
  readonly rateWindowMs: number;
  readonly maxSendsPerEmail: number;
  readonly maxSendsPerClient: number;
  readonly maxVerificationsPerClient: number;
  readonly maxVerificationsPerEmail: number;
  readonly maxCodeFailures: number;
  readonly recentAuthenticationMs: number;
}

export const DEFAULT_AUTH_POLICY: AuthPolicy = Object.freeze({
  challengeLifetimeMs: 10 * 60_000,
  sessionLifetimeMs: 7 * 24 * 60 * 60_000,
  sendCooldownMs: 60_000,
  rateWindowMs: 15 * 60_000,
  maxSendsPerEmail: 3,
  maxSendsPerClient: 20,
  maxVerificationsPerClient: 50,
  maxVerificationsPerEmail: 10,
  maxCodeFailures: 5,
  recentAuthenticationMs: 5 * 60_000,
});

/** Only this projection may leave the private account persistence boundary. */
export function toProfile(user: AuthUserRecord): UserProfile {
  return {
    id: user.id, email: user.email, displayName: user.displayName,
    timezone: user.timezone, emailVerifiedAt: user.emailVerifiedAt,
    revision: user.revision,
  };
}

export function toActor(user: AuthUserRecord): Actor {
  return { userId: user.id, platformRoles: [...user.platformRoles] };
}
