import type { Actor, Clock, IdGenerator } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { AuthCryptoPort, AuthQueryPort, AuthStorePort, LoginEmailPort } from "./ports.ts";
import {
  DEFAULT_AUTH_POLICY, toActor, toProfile,
  type AccountSettings, type AuthPolicy, type LoginChallengeReceipt, type ProfileUpdate,
  type SessionContext, type SessionGrant, type SessionRevocationReceipt, type UserProfile,
} from "./types.ts";

function unauthenticated(): DomainError {
  return new DomainError("AUTH_SESSION_REQUIRED", "登录已失效，请重新登录。", { status: 401, recoveryAction: "login" });
}

export function normalizeLoginEmail(value: unknown): string {
  if (typeof value !== "string" || value.length > 254) {
    throw new DomainError("AUTH_EMAIL_INVALID", "请填写有效的邮箱地址。");
  }
  const email = value.trim().toLowerCase();
  // V1 accepts ASCII mailbox addresses. Dots/plus aliases are never collapsed.
  if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email)
      || email.split("@")[0]!.length > 64 || email.split("@")[1]!.split(".").some((label) => label.length > 63)) {
    throw new DomainError("AUTH_EMAIL_INVALID", "请填写有效的邮箱地址。");
  }
  return email;
}

/** Only known internal destinations are accepted; encoded/control bypasses fall back. */
export function safeAuthReturnTo(value: unknown): string {
  if (value === "/app/account/guancha") return value;
  if (typeof value === "string" && /^\/competitions\/[A-Za-z0-9_-]{1,128}\/submit\?receipt=[A-Za-z0-9_-]{1,128}$/.test(value)) return value;
  if (typeof value === "string" && /^\/organizers\/workspace\?event=[A-Za-z0-9_-]{1,128}$/.test(value)) return value;
  if (typeof value === "string" && /^\/(?:participation|app)\?event=[A-Za-z0-9_-]{1,128}$/.test(value)) return value;
  if (typeof value === "string" && /^\/app\/projects\/[A-Za-z0-9_-]{1,128}\/rules\?discovery=[A-Za-z0-9_-]{1,128}$/.test(value)) return value;
  if (typeof value === "string" && /^\/app\/account\?event=[A-Za-z0-9_-]{1,128}$/.test(value)) return value;
  if (typeof value === "string" && value.length <= 2048 && !/[\\\u0000-\u0020\u007f#]/.test(value)) {
    const [path, query, extra] = value.split("?");
    const skills = /^\/skills(?:\/bundles\/[A-Za-z0-9_-]+|\/[A-Za-z0-9_-]+)?$/.test(path!);
    const presentation = path === "/roadshow" || path === "/ppt";
    const resources = /^\/resources(?:\/[A-Za-z0-9_-]+)?$/.test(path!);
    const github = path === "/github";
    if ((skills || presentation || resources || github) && extra === undefined) {
      if (query === undefined) return path!;
      if (!/%(?![A-Fa-f0-9]{2})/.test(query)) {
        const parameters = new URLSearchParams(query), seen = new Set<string>();
        let valid = true;
        for (const [name, item] of parameters) {
          const allowed = resources ? ["search", "type", "stage", "stack", "prerequisite", "use", "costType", "sort", "limit", "cursor"]
            : skills ? ["agentId", "track", "category", "search", "versionId"] : path === "/ppt" ? ["projectId", "roadshowId"] : ["projectId"];
          const acceptedValue = resources ? validResourceReturnFilter(name, item)
            : name === "search" ? item.length <= 200
            : name === "versionId" ? /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,199}$/.test(item)
            : name === "projectId" ? /^[A-Za-z0-9_-]{1,128}$/.test(item)
            : name === "roadshowId" ? /^[A-Za-z0-9_-]{1,200}$/.test(item)
            : /^[A-Za-z0-9_-]{1,64}$/.test(item);
          if (seen.has(name) || !allowed.includes(name) || /[\u0000-\u001f\u007f]/.test(item)
            || (!resources && /\\/.test(item)) || !acceptedValue) valid = false;
          seen.add(name);
        }
        if (valid) return `${path}${parameters.size ? `?${parameters.toString()}` : ""}`;
      }
      return "/app";
    }
  }
  if (typeof value !== "string" || value.length > 512 || /[%\\\u0000-\u0020\u007f?#]/.test(value)) return "/app";
  if (["/app", "/admin", "/admin/services", "/admin/organizers", "/account", "/app/account", "/app/teams", "/resources", "/events", "/library", "/skills", "/participation", "/roadshow", "/ppt", "/register", "/inspiration", "/github", "/journey", "/organizers", "/organizers/workspace", "/competitions"].includes(value)) return value;
  // Event IDs select a destination only; event/organization grants are checked by the target service.
  if (/^\/competitions\/[A-Za-z0-9_-]{1,128}(?:\/(?:register|teams|help|schedule|services|submit|results))?$/.test(value)) return value;
  if (/^\/judging\/[A-Za-z0-9_-]{1,128}$/.test(value)) return value;
  if (value === "/me/competitions" || /^\/organizers\/workspace\/[A-Za-z0-9_-]{1,128}\/(?:registration|teams|communication|schedule|services|judging)$/.test(value)) return value;
  if (/^\/app\/join\/[A-Za-z0-9_-]{43}$/.test(value)) return value;
  if (/^\/app\/projects\/[A-Za-z0-9_-]+(?:\/(?:rules|team|assessment|plan|delivery|resources|retrospective))?$/.test(value)) return value;
  if (/^\/(?:events|resources|library|skills)\/[A-Za-z0-9_-]+$/.test(value)) return value;
  if (/^\/app\/teams\/[A-Za-z0-9_-]+$/.test(value)) return value;
  if (/^\/settings\/(?:profile|security|connections|data)$/.test(value)) return value;
  return "/app";
}

/** Mirrors the public resource-location contract without importing another module's private files. */
function validResourceReturnFilter(name: string, value: string): boolean {
  if (name === "search") return value.length > 0 && value.length <= 200;
  if (name === "limit") return /^\d{1,2}$/.test(value) && Number(value) >= 1 && Number(value) <= 50;
  if (name === "cursor") return /^\d{1,7}$/.test(value) && Number(value) <= 1000000;
  const options: Readonly<Record<string, readonly string[]>> = {
    type: ["inspiration", "ai_design", "ui_visual", "practical_tool"],
    stage: ["preparation", "design", "development", "delivery", "retrospective"],
    stack: ["stack_agnostic", "html_css", "react", "vue", "unknown"],
    prerequisite: ["browse", "account", "basic_code", "environment"],
    use: ["layout", "workspace", "form", "flowchart", "icons", "prototype", "collaboration", "development", "deployment", "presentation", "review"],
    costType: ["free_plan", "free_and_paid", "usage_based", "self_hosted", "unknown"],
    sort: ["editorial", "name", "verified"],
  };
  return options[name]?.includes(value) ?? false;
}

export interface AuthServiceDependencies {
  readonly store: AuthStorePort;
  readonly crypto: AuthCryptoPort;
  readonly email: LoginEmailPort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly policy?: Partial<AuthPolicy>;
}

export class AuthService implements AuthQueryPort {
  private readonly deps: AuthServiceDependencies;
  private readonly policy: AuthPolicy;

  constructor(deps: AuthServiceDependencies) {
    this.deps = deps;
    this.policy = { ...DEFAULT_AUTH_POLICY, ...deps.policy };
    for (const number of Object.values(this.policy)) {
      if (!Number.isSafeInteger(number) || number <= 0) throw new Error("Auth policy values must be positive safe integers.");
    }
    if (this.policy.sendCooldownMs > this.policy.rateWindowMs) throw new Error("Auth cooldown must fit the rate window.");
  }

  async requestLoginChallenge(emailInput: unknown, trustedClientKey: string): Promise<LoginChallengeReceipt> {
    return this.requestChallenge(emailInput, trustedClientKey, null);
  }

  async requestRegistrationChallenge(input: { readonly email: unknown; readonly displayName: unknown }, trustedClientKey: string): Promise<LoginChallengeReceipt> {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some((key) => !["email", "displayName"].includes(key))) {
      throw new DomainError("AUTH_FIELDS_INVALID", "注册只需填写姓名和邮箱。");
    }
    if (typeof input.displayName !== "string" || !input.displayName.trim()
      || input.displayName.trim().length > 60 || /[\u0000-\u001f\u007f]/.test(input.displayName)) {
      throw new DomainError("AUTH_PROFILE_INVALID", "姓名需要为 1 至 60 个字符。");
    }
    return this.requestChallenge(input.email, trustedClientKey, input.displayName.trim());
  }

  private async requestChallenge(emailInput: unknown, trustedClientKey: string, registrationDisplayName: string | null): Promise<LoginChallengeReceipt> {
    const email = normalizeLoginEmail(emailInput);
    this.validateClientKey(trustedClientKey);
    const now = this.deps.clock.now();
    const expiresAt = new Date(now.getTime() + this.policy.challengeLifetimeMs).toISOString();
    const id = this.deps.ids.next();
    const code = this.deps.crypto.generateCode();
    const reserved = await this.deps.store.reserveChallenge({
      challenge: {
        id, email, codeHash: this.deps.crypto.hashCode(id, code), createdAt: now.toISOString(),
        expiresAt, delivery: "pending", failedAttempts: 0, consumedAt: null, revokedAt: null, registrationDisplayName,
      },
      emailRateKey: this.deps.crypto.hashRateKey("send-email", email),
      clientRateKey: this.deps.crypto.hashRateKey("send-client", trustedClientKey), policy: this.policy,
    });
    if (!reserved) throw new DomainError("AUTH_RATE_LIMITED", "请求过于频繁，请稍后重新获取验证码。", { status: 429, recoveryAction: "wait_and_retry" });
    try {
      await this.deps.email.sendLoginCode({ email, code, expiresAt });
    } catch {
      await this.deps.store.markChallengeDelivery(id, "failed", this.deps.clock.now().toISOString());
      throw new DomainError("AUTH_EMAIL_UNAVAILABLE", "验证邮件暂时无法发送，请稍后重试。", { status: 503, recoveryAction: "retry_later" });
    }
    if (!await this.deps.store.markChallengeDelivery(id, "ready", this.deps.clock.now().toISOString())) {
      throw new DomainError("AUTH_CHALLENGE_UNAVAILABLE", "本次验证码已失效，请重新获取。", { status: 409, recoveryAction: "request_new_code" });
    }
    return {
      challengeId: id, expiresAt, resendAfterSeconds: Math.ceil(this.policy.sendCooldownMs / 1000),
      message: "验证邮件已受理，请查看邮箱并输入验证码。",
    };
  }

  async verifyLoginChallenge(input: { readonly challengeId: unknown; readonly code: unknown; readonly returnTo?: unknown }, trustedClientKey: string): Promise<SessionGrant> {
    this.validateClientKey(trustedClientKey);
    const now = this.deps.clock.now();
    if (!await this.deps.store.takeVerificationSlot(this.deps.crypto.hashRateKey("verify-client", trustedClientKey), now.toISOString(), this.policy)) {
      throw new DomainError("AUTH_RATE_LIMITED", "验证请求过于频繁，请稍后再试。", { status: 429, recoveryAction: "wait_and_retry" });
    }
    const challengeId = typeof input.challengeId === "string" && input.challengeId.length <= 128 ? input.challengeId : "";
    // Malformed codes also count against a known challenge's attempt budget.
    const code = typeof input.code === "string" && /^[0-9]{8}$/.test(input.code) ? input.code : "invalid-code-format";
    const token = this.deps.crypto.generateSessionToken();
    const expiresAt = new Date(now.getTime() + this.policy.sessionLifetimeMs).toISOString();
    const result = await this.deps.store.consumeChallenge({
      challengeId, codeHash: this.deps.crypto.hashCode(challengeId, code), now: now.toISOString(),
      policy: this.policy, newUserId: this.deps.ids.next(),
      newSession: {
        id: this.deps.ids.next(), tokenHash: this.deps.crypto.hashSessionToken(token),
        createdAt: now.toISOString(), authenticatedAt: now.toISOString(), expiresAt, revokedAt: null,
        lastSeenAt: now.toISOString(),
      },
    });
    if (result.status !== "verified") {
      throw new DomainError("AUTH_CHALLENGE_INVALID", "验证码无效、已使用或已过期，请重新获取。", { status: 401, recoveryAction: "request_new_code" });
    }
    return { sessionToken: token, expiresAt: result.session.expiresAt, profile: toProfile(result.user), returnTo: safeAuthReturnTo(input.returnTo) };
  }

  /** Registration and login share one atomic verifier and reveal no account-existence branch. */
  async verifyRegistrationChallenge(input: { readonly challengeId: unknown; readonly code: unknown; readonly returnTo?: unknown }, trustedClientKey: string): Promise<SessionGrant> {
    return this.verifyLoginChallenge(input, trustedClientKey);
  }

  async getActor(sessionToken: string | null | undefined): Promise<Actor | null> {
    const context = await this.getContext(sessionToken);
    return context ? toActor(context.user) : null;
  }

  async requireActor(sessionToken: string | null | undefined): Promise<Actor> {
    const actor = await this.getActor(sessionToken);
    if (!actor) throw unauthenticated();
    return actor;
  }

  async getCurrentProfile(sessionToken: string | null | undefined): Promise<UserProfile> {
    const context = await this.getContext(sessionToken);
    if (!context) throw unauthenticated();
    return toProfile(context.user);
  }

  async logout(sessionToken: string | null | undefined): Promise<void> {
    if (this.validSessionToken(sessionToken)) {
      await this.deps.store.revokeSessionByToken(this.deps.crypto.hashSessionToken(sessionToken), this.deps.clock.now().toISOString());
    }
  }

  async logoutAll(sessionToken: string | null | undefined): Promise<void> {
    const tokenHash = this.requireTokenHash(sessionToken);
    const now = this.deps.clock.now();
    const result = await this.deps.store.revokeOwnSessions({
      currentTokenHash: tokenHash, targetSessionId: null, now: now.toISOString(),
      authenticatedAfter: new Date(now.getTime() - this.policy.recentAuthenticationMs).toISOString(),
    });
    if (result.status === "unauthenticated") throw unauthenticated();
    if (result.status === "reauthentication_required") {
      throw new DomainError("AUTH_REAUTHENTICATION_REQUIRED", "退出全部设备前，请重新验证邮箱。", { status: 403, recoveryAction: "reauthenticate" });
    }
  }

  async revokeOwnSession(sessionToken: string | null | undefined, targetSessionId: string): Promise<SessionRevocationReceipt> {
    if (!targetSessionId || targetSessionId.length > 128) throw new DomainError("AUTH_SESSION_ID_INVALID", "请选择需要退出的设备会话。");
    const result = await this.deps.store.revokeOwnSessions({
      currentTokenHash: this.requireTokenHash(sessionToken), targetSessionId,
      now: this.deps.clock.now().toISOString(), authenticatedAfter: null,
    });
    if (result.status !== "revoked") throw unauthenticated();
    return { revoked: result.revoked, currentSessionRevoked: result.currentSessionRevoked };
  }

  async getAccountSettings(sessionToken: string | null | undefined): Promise<AccountSettings> {
    const snapshot = await this.deps.store.getOwnAccountSnapshot(this.requireTokenHash(sessionToken), this.deps.clock.now().toISOString());
    if (!snapshot) throw unauthenticated();
    const recentAuthenticationUntil = new Date(Date.parse(snapshot.currentSession.authenticatedAt) + this.policy.recentAuthenticationMs).toISOString();
    const currentSession = snapshot.sessions.find((session) => session.current);
    if (!currentSession) throw unauthenticated();
    return {
      profile: toProfile(snapshot.user), currentSession, sessions: snapshot.sessions,
      recentAuthenticationUntil, canLogoutAll: this.deps.clock.now().getTime() <= Date.parse(recentAuthenticationUntil),
    };
  }

  async listOwnSessions(sessionToken: string | null | undefined) {
    const result = await this.deps.store.listOwnSessions(this.requireTokenHash(sessionToken), this.deps.clock.now().toISOString());
    if (!result) throw unauthenticated();
    return result;
  }

  async updateOwnProfile(sessionToken: string | null | undefined, input: ProfileUpdate): Promise<UserProfile> {
    const { displayName, timezone, expectedRevision } = input;
    if (typeof displayName !== "string" || !displayName.trim() || displayName.trim().length > 60 || /[\u0000-\u001f\u007f]/.test(displayName)) {
      throw new DomainError("AUTH_PROFILE_INVALID", "昵称需要为 1 至 60 个字符。");
    }
    if (typeof timezone !== "string" || timezone.length > 100) throw new DomainError("AUTH_TIMEZONE_INVALID", "请选择有效的时区。");
    try { new Intl.DateTimeFormat("zh-CN", { timeZone: timezone }).format(); }
    catch { throw new DomainError("AUTH_TIMEZONE_INVALID", "请选择有效的时区。"); }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new DomainError("AUTH_REVISION_INVALID", "请携带当前资料版本后再保存。");
    const result = await this.deps.store.updateOwnProfile(this.requireTokenHash(sessionToken), {
      displayName: displayName.trim(), timezone, expectedRevision,
    }, this.deps.clock.now().toISOString());
    if (result.status === "unauthenticated") throw unauthenticated();
    if (result.status === "conflict") throw new DomainError("VERSION_CONFLICT", "账号资料已更新，请查看最新版本再保存。", { status: 409, latestRevision: result.latestRevision, recoveryAction: "review_latest_version" });
    return toProfile(result.user);
  }

  private validateClientKey(key: string): void {
    if (typeof key !== "string" || !key || key.length > 512) throw new Error("A trusted server-derived client rate key is required.");
  }

  private validSessionToken(token: string | null | undefined): token is string {
    return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
  }

  private requireTokenHash(token: string | null | undefined): string {
    if (!this.validSessionToken(token)) throw unauthenticated();
    return this.deps.crypto.hashSessionToken(token);
  }

  private async getContext(token: string | null | undefined): Promise<SessionContext | null> {
    if (!this.validSessionToken(token)) return null;
    return this.deps.store.getSessionContext(this.deps.crypto.hashSessionToken(token), this.deps.clock.now().toISOString());
  }
}
