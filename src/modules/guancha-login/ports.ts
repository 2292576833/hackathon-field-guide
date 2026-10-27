import type {
  GuanchaAttemptSecrets, GuanchaLoginAttempt, GuanchaProviderConfiguration,
  GuanchaVerifiedIdentity,
} from "./types.ts";

export interface GuanchaCryptoPort {
  randomToken(): string;
  hash(value: string): string;
  s256(value: string): string;
  seal(value: GuanchaAttemptSecrets, stateHash: string): string;
  open(ciphertext: string, stateHash: string): GuanchaAttemptSecrets;
}

export interface GuanchaAttemptStorePort {
  save(attempt: GuanchaLoginAttempt): Promise<void>;
  /** Atomic comparison + single consumption. Commit BEFORE any token exchange.
   * Wrong binding/expired state must not consume a valid attempt. Erase ciphertext
   * on consumption. No retry/reclaim of a consumed attempt after external failure. */
  consume(input: {
    readonly stateHash: string;
    readonly browserBindingHash: string;
    readonly issuer: string;
    readonly configurationId: string;
    readonly redirectUri: string;
    readonly now: string;
  }): Promise<GuanchaLoginAttempt | null>;
}

/** Only implement after official documentation is confirmed. No default endpoints. */
export interface GuanchaProviderPort {
  readonly configuration: GuanchaProviderConfiguration;
  authorizationUrl(input: {
    readonly state: string;
    readonly redirectUri: string;
    readonly codeChallenge: string | null;
    readonly nonce: string | null;
  }): string;
  /** One exchange attempt; no automatic HTTP retry or redirect. Validate the
   * official userinfo response (or OIDC signature/iss/aud/exp/nonce) before return.
   * Never decode an unverified JWT as identity or return access/refresh tokens. */
  exchangeAndVerify(input: {
    readonly code: string;
    readonly redirectUri: string;
    readonly codeVerifier: string | null;
    readonly expectedNonce: string | null;
  }): Promise<GuanchaVerifiedIdentity>;
}

/** Coordinator implementation only. Never accept actor/user ID from callback.
 * Atomically resolve exact issuer+subject, check active user, and issue existing
 * M01 session. Unbound identity requires explicit verified-account onboarding;
 * no matching/merging by email/name, no fabricated verified email. Binding an
 * existing user requires their recent M01 authentication + separate consent.
 * Return value is server-only (it may contain a session cookie grant). */
export interface GuanchaIdentityPort<Result> {
  completeLogin(input: {
    readonly identity: GuanchaVerifiedIdentity;
    readonly now: string;
    readonly returnTo: string;
    /** Hash of the successfully consumed browser cookie, for a pending link. */
    readonly browserBindingHash: string;
  }): Promise<Result>;
}
