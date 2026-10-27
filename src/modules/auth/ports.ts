import type { Actor } from "../../shared/contracts.ts";
import type {
  AuthPolicy, AuthUserRecord, LoginChallengeRecord, ProfileUpdate,
  OwnAccountSnapshot, SessionContext, SessionRecord, SessionSummary,
} from "./types.ts";

export interface AuthCryptoPort {
  generateCode(): string;
  generateSessionToken(): string;
  hashCode(challengeId: string, code: string): string;
  hashSessionToken(token: string): string;
  hashRateKey(purpose: string, value: string): string;
}

export interface LoginEmailPort {
  /** Resolve only after the provider accepts the send; reject on failure/timeout. */
  sendLoginCode(input: {
    readonly email: string;
    readonly code: string;
    readonly expiresAt: string;
  }): Promise<void>;
}

export interface AuthQueryPort {
  /** Raw token comes from the trusted server cookie boundary, never an actor JSON field. */
  getActor(sessionToken: string | null | undefined): Promise<Actor | null>;
  requireActor(sessionToken: string | null | undefined): Promise<Actor>;
}

/** Server-only adapter: this key limits traffic and never grants account/project identity. */
export interface AuthClientKeyPort {
  getClientKey(request: Request): Promise<string>;
}

/** Socket/framework metadata only; never implement by reading a caller-supplied peer header. */
export interface ClientConnectionPort {
  getPeerAddress(request: Request): string | null | Promise<string | null>;
}

export type RevokeSessionsResult =
  | { readonly status: "revoked"; readonly revoked: boolean; readonly currentSessionRevoked: boolean }
  | { readonly status: "unauthenticated" | "reauthentication_required" };

export type ConsumeChallengeResult =
  | { readonly status: "verified"; readonly user: AuthUserRecord; readonly session: SessionRecord }
  | { readonly status: "invalid" };

export type ProfileUpdateResult =
  | { readonly status: "updated"; readonly user: AuthUserRecord }
  | { readonly status: "unauthenticated" }
  | { readonly status: "conflict"; readonly latestRevision: number };

/** All authentication decisions and associated writes below are atomic. */
export interface AuthStorePort {
  reserveChallenge(input: {
    readonly challenge: LoginChallengeRecord;
    readonly emailRateKey: string;
    readonly clientRateKey: string;
    readonly policy: AuthPolicy;
  }): Promise<boolean>;
  markChallengeDelivery(challengeId: string, delivery: "ready" | "failed", now: string): Promise<boolean>;
  takeVerificationSlot(clientRateKey: string, now: string, policy: AuthPolicy): Promise<boolean>;
  consumeChallenge(input: {
    readonly challengeId: string;
    readonly codeHash: string;
    readonly now: string;
    readonly policy: AuthPolicy;
    readonly newUserId: string;
    readonly newSession: Omit<SessionRecord, "userId">;
  }): Promise<ConsumeChallengeResult>;
  getSessionContext(tokenHash: string, now: string): Promise<SessionContext | null>;
  revokeSessionByToken(tokenHash: string, now: string): Promise<void>;
  revokeOwnSessions(input: {
    readonly currentTokenHash: string;
    readonly targetSessionId: string | null;
    readonly now: string;
    /** Required for all-device revocation; null for a single device. */
    readonly authenticatedAfter: string | null;
  }): Promise<RevokeSessionsResult>;
  listOwnSessions(tokenHash: string, now: string): Promise<readonly SessionSummary[] | null>;
  getOwnAccountSnapshot(tokenHash: string, now: string): Promise<OwnAccountSnapshot | null>;
  updateOwnProfile(tokenHash: string, input: ProfileUpdate, now: string): Promise<ProfileUpdateResult>;
}
