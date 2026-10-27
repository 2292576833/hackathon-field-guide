import type { Clock } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { GuanchaAttemptStorePort, GuanchaCryptoPort, GuanchaIdentityPort, GuanchaProviderPort } from "./ports.ts";
import type { GuanchaBeginResult, GuanchaCallbackInput, GuanchaProviderConfiguration, GuanchaVerifiedIdentity } from "./types.ts";

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const unavailable = () => new DomainError("GUANCHA_LOGIN_UNAVAILABLE", "观猹登录暂时不可用，请使用邮箱验证码登录。", { status: 503 });
const invalid = () => new DomainError("GUANCHA_LOGIN_INVALID", "这次登录已失效，请重新发起观猹登录。", { status: 400 });

export interface GuanchaLoginDependencies<Result> {
  readonly attempts: GuanchaAttemptStorePort;
  readonly crypto: GuanchaCryptoPort;
  readonly identity: GuanchaIdentityPort<Result>;
  /** Omit until the official protocol and registered callback are confirmed. */
  readonly provider?: GuanchaProviderPort;
  readonly clock: Clock;
  /** Inject M01's public safeAuthReturnTo, preserving its existing allowlist. */
  readonly safeReturnTo: (input: unknown) => string;
  readonly attemptLifetimeMs?: number;
}

function httpsUrl(input: string, allowQuery: boolean): URL {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (!allowQuery && url.search)
      || /[\u0000-\u0020\u007f\\]/.test(input)) throw new Error("Invalid Guancha trusted URL configuration.");
  return url;
}

function validateConfiguration(config: GuanchaProviderConfiguration): void {
  httpsUrl(config.issuer, false);
  httpsUrl(config.authorizationEndpoint, false);
  httpsUrl(config.redirectUri, false);
  httpsUrl(config.documentationUrl, true);
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(config.configurationId)
      || !["S256", "documented-unsupported"].includes(config.pkce) || typeof config.useNonce !== "boolean") {
    throw new Error("Guancha login requires a documented protocol configuration.");
  }
}

/** Independently refuses external, encoded, or protocol-relative redirects if a
 * future injected normalizer is accidentally weakened. Authorization decisions
 * still belong to the destination service. */
function internalDestination(value: string): string {
  if (typeof value !== "string" || value.length > 2048 || !/^\/[A-Za-z0-9]/.test(value)
      || /[\\\u0000-\u0020\u007f#]/.test(value)) return "/app";
  try {
    const decoded = decodeURIComponent(value);
    if (/[\\\u0000-\u001f\u007f]/.test(decoded) || decoded.startsWith("//")) return "/app";
    if (new URL(value, "https://internal.invalid").origin !== "https://internal.invalid") return "/app";
    return value;
  } catch { return "/app"; }
}

function verifiedIdentity(value: GuanchaVerifiedIdentity, issuer: string): GuanchaVerifiedIdentity {
  if (!value || value.issuer !== issuer || typeof value.subject !== "string"
      || value.subject.length < 1 || value.subject.length > 512
      || /[\u0000-\u0020\u007f]/.test(value.subject)) throw unavailable();
  const displayName = typeof value.displayName === "string" ? value.displayName.trim() : "";
  // Only explicit fields cross into account handling. In particular never email,
  // email_verified, caller user ID, platform roles, or a raw token response.
  return {
    issuer, subject: value.subject,
    ...(displayName && displayName.length <= 60 && !/[\u0000-\u001f\u007f]/.test(displayName) ? { displayName } : {}),
  };
}

export class GuanchaLoginService<Result> {
  private readonly deps: GuanchaLoginDependencies<Result>;
  private readonly config: GuanchaProviderConfiguration | undefined;
  private readonly lifetimeMs: number;
  constructor(deps: GuanchaLoginDependencies<Result>) {
    this.deps = deps;
    this.config = deps.provider ? Object.freeze({ ...deps.provider.configuration }) : undefined;
    if (this.config) validateConfiguration(this.config);
    this.lifetimeMs = deps.attemptLifetimeMs ?? 10 * 60_000;
    if (!Number.isSafeInteger(this.lifetimeMs) || this.lifetimeMs < 60_000 || this.lifetimeMs > 15 * 60_000) {
      throw new Error("Guancha login attempts must expire within 1 to 15 minutes.");
    }
  }

  get enabled(): boolean { return this.config !== undefined; }

  async begin(returnTo?: unknown): Promise<GuanchaBeginResult> {
    const config = this.config, provider = this.deps.provider;
    if (!config || !provider) throw unavailable();
    try {
      const state = this.deps.crypto.randomToken(), browserBinding = this.deps.crypto.randomToken();
      const codeVerifier = config.pkce === "S256" ? this.deps.crypto.randomToken() : null;
      const nonce = config.useNonce ? this.deps.crypto.randomToken() : null;
      if (![state, browserBinding, ...(codeVerifier ? [codeVerifier] : []), ...(nonce ? [nonce] : [])].every(value => tokenPattern.test(value))) throw unavailable();
      const stateHash = this.deps.crypto.hash(state);
      const codeChallenge = codeVerifier ? this.deps.crypto.s256(codeVerifier) : null;
      const authorizationUrl = provider.authorizationUrl({ state, redirectUri: config.redirectUri, codeChallenge, nonce });
      const url = httpsUrl(authorizationUrl, true), expected = new URL(config.authorizationEndpoint);
      const exactParam = (name: string, value: string) => url.searchParams.getAll(name).length === 1 && url.searchParams.get(name) === value;
      if (url.origin !== expected.origin || url.pathname !== expected.pathname
          || !exactParam("state", state) || !exactParam("redirect_uri", config.redirectUri)
          || !exactParam("response_type", "code")
          || (codeChallenge !== null && (!exactParam("code_challenge", codeChallenge) || !exactParam("code_challenge_method", "S256")))
          || (codeChallenge === null && (url.searchParams.has("code_challenge") || url.searchParams.has("code_challenge_method")))
          || (nonce !== null && !exactParam("nonce", nonce))
          || ["client_secret", "access_token", "refresh_token", "code_verifier"].some(key => url.searchParams.has(key))) throw unavailable();
      const createdAt = this.deps.clock.now().toISOString();
      const expiresAt = new Date(Date.parse(createdAt) + this.lifetimeMs).toISOString();
      await this.deps.attempts.save({
        stateHash, browserBindingHash: this.deps.crypto.hash(browserBinding),
        issuer: config.issuer, configurationId: config.configurationId, redirectUri: config.redirectUri,
        returnTo: internalDestination(this.deps.safeReturnTo(returnTo)),
        secretCiphertext: this.deps.crypto.seal({ codeVerifier, nonce }, stateHash), createdAt, expiresAt,
      });
      return { authorizationUrl, browserBinding, expiresAt };
    } catch { throw unavailable(); }
  }

  async complete(input: GuanchaCallbackInput): Promise<Result> {
    const config = this.config, provider = this.deps.provider;
    if (!config || !provider) throw unavailable();
    if (typeof input.state !== "string" || !tokenPattern.test(input.state)
        || typeof input.browserBinding !== "string" || !tokenPattern.test(input.browserBinding)) throw invalid();
    let attempt;
    try {
      attempt = await this.deps.attempts.consume({
        stateHash: this.deps.crypto.hash(input.state), browserBindingHash: this.deps.crypto.hash(input.browserBinding),
        issuer: config.issuer, configurationId: config.configurationId, redirectUri: config.redirectUri,
        now: this.deps.clock.now().toISOString(),
      });
    } catch { throw unavailable(); }
    if (!attempt) throw invalid();
    // Both cancellation and malformed responses burn a legitimately bound state.
    // Raw provider errors/error_description are deliberately never echoed.
    if (input.error !== undefined) {
      if (input.error === "access_denied" && input.code === undefined) {
        throw new DomainError("GUANCHA_LOGIN_CANCELLED", "已取消观猹登录，你也可以使用邮箱验证码登录。", { status: 400 });
      }
      throw invalid();
    }
    if (typeof input.code !== "string" || input.code.length < 1 || input.code.length > 2048 || /[\u0000-\u0020\u007f]/.test(input.code)) throw invalid();
    let identity: GuanchaVerifiedIdentity;
    try {
      const secrets = this.deps.crypto.open(attempt.secretCiphertext, attempt.stateHash);
      if ((config.pkce === "S256") !== (secrets.codeVerifier !== null) || config.useNonce !== (secrets.nonce !== null)) throw unavailable();
      identity = verifiedIdentity(await provider.exchangeAndVerify({
        code: input.code, redirectUri: attempt.redirectUri, codeVerifier: secrets.codeVerifier, expectedNonce: secrets.nonce,
      }), config.issuer);
    } catch { throw unavailable(); }
    if (Date.parse(attempt.expiresAt) <= this.deps.clock.now().getTime()) throw invalid();
    try {
      return await this.deps.identity.completeLogin({
        identity, now: this.deps.clock.now().toISOString(), returnTo: internalDestination(this.deps.safeReturnTo(attempt.returnTo)),
        browserBindingHash: attempt.browserBindingHash,
      });
    } catch (error) {
      // Preserve the coordinator's known account-denial meaning without ever
      // forwarding its message/details, and never trust errors from provider I/O.
      if (error instanceof DomainError && error.code === "GUANCHA_ACCOUNT_UNAVAILABLE") {
        throw new DomainError("GUANCHA_ACCOUNT_UNAVAILABLE", "当前账号无法登录，请检查账号状态。", { status: 403 });
      }
      throw unavailable();
    }
  }
}
