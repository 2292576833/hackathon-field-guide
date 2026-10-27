/**
 * TEST ONLY: deterministic collaborators for AuthService behavior tests.
 * This serial in-memory store is not a production persistence adapter and must
 * never be exported through the module's public index or wired into app routes.
 */
import type { Clock, IdGenerator } from "../../shared/contracts.ts";
import type { AuthStorePort, ConsumeChallengeResult, LoginEmailPort, ProfileUpdateResult, RevokeSessionsResult } from "./ports.ts";
import type {
  AccountStatus, AuthPolicy, AuthUserRecord, LoginChallengeRecord, ProfileUpdate,
  OwnAccountSnapshot, SessionContext, SessionRecord, SessionSummary,
} from "./types.ts";

export class FixtureClock implements Clock {
  private current: number;
  constructor(initial = "2026-10-08T04:00:00.000Z") { this.current = Date.parse(initial); }
  now(): Date { return new Date(this.current); }
  advance(ms: number): void { this.current += ms; }
  set(value: string): void { this.current = Date.parse(value); }
}

export class FixtureIds implements IdGenerator {
  private value = 0;
  next(): string { return `auth-test-${++this.value}`; }
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

export class CapturingLoginEmail implements LoginEmailPort {
  readonly sent: Array<Parameters<LoginEmailPort["sendLoginCode"]>[0]> = [];
  failure: Error | null = null;
  gate: Promise<void> | null = null;
  async sendLoginCode(input: Parameters<LoginEmailPort["sendLoginCode"]>[0]): Promise<void> {
    this.sent.push({ ...input });
    if (this.gate) await this.gate;
    if (this.failure) throw this.failure;
  }
}

interface FixtureChallenge extends LoginChallengeRecord { readonly emailRateKey: string }
interface FixtureRate { readonly startedAt: string; readonly count: number; readonly lastAt: string | null }
interface FixtureState {
  users: Map<string, AuthUserRecord>;
  challenges: Map<string, FixtureChallenge>;
  sessions: Map<string, SessionRecord>;
  rates: Map<string, FixtureRate>;
}
const time = (value: string): number => Date.parse(value);

export class SerialAuthStoreFixture implements AuthStorePort {
  private state: FixtureState = { users: new Map(), challenges: new Map(), sessions: new Map(), rates: new Map() };
  private tail: Promise<void> = Promise.resolve();
  private readonly clock: Clock;
  constructor(clock: Clock) { this.clock = clock; }

  snapshot() {
    return structuredClone({
      users: [...this.state.users.values()], challenges: [...this.state.challenges.values()],
      sessions: [...this.state.sessions.values()], rates: [...this.state.rates.entries()],
    });
  }

  async setAccountStatus(id: string, status: AccountStatus): Promise<void> {
    await this.atomic(() => {
      const user = this.state.users.get(id);
      if (!user) throw new Error("Fixture user not found.");
      this.state.users.set(id, { ...user, status });
    });
  }

  /** Model a queued transaction so tests can advance time while a request waits. */
  blockTransactions() {
    const entered = deferred<void>(); const gate = deferred<void>();
    const finished = this.atomic(async () => { entered.resolve(); await gate.promise; });
    return { entered: entered.promise, release: () => gate.resolve(), finished };
  }

  async reserveChallenge(input: Parameters<AuthStorePort["reserveChallenge"]>[0]): Promise<boolean> {
    return this.atomic(() => {
      const now = this.clock.now().toISOString(); const { policy } = input;
      if (!this.available(input.emailRateKey, now, policy.rateWindowMs, policy.maxSendsPerEmail, policy.sendCooldownMs)
          || !this.available(input.clientRateKey, now, policy.rateWindowMs, policy.maxSendsPerClient)) return false;
      this.increment(input.emailRateKey, now, policy.rateWindowMs);
      this.increment(input.clientRateKey, now, policy.rateWindowMs);
      for (const challenge of this.state.challenges.values()) {
        if (challenge.email === input.challenge.email && challenge.consumedAt === null && challenge.revokedAt === null) {
          this.state.challenges.set(challenge.id, { ...challenge, revokedAt: now });
        }
      }
      this.state.challenges.set(input.challenge.id, { ...input.challenge, emailRateKey: input.emailRateKey });
      return true;
    });
  }

  async markChallengeDelivery(id: string, delivery: "ready" | "failed", _now: string): Promise<boolean> {
    return this.atomic(() => {
      const challenge = this.state.challenges.get(id);
      if (!challenge || challenge.delivery !== "pending" || challenge.revokedAt !== null || challenge.consumedAt !== null
          || time(challenge.expiresAt) <= this.clock.now().getTime()) return false;
      this.state.challenges.set(id, { ...challenge, delivery });
      return true;
    });
  }

  async takeVerificationSlot(key: string, _now: string, policy: AuthPolicy): Promise<boolean> {
    return this.atomic(() => {
      const now = this.clock.now().toISOString();
      if (!this.available(key, now, policy.rateWindowMs, policy.maxVerificationsPerClient)) return false;
      this.increment(key, now, policy.rateWindowMs);
      return true;
    });
  }

  async consumeChallenge(input: Parameters<AuthStorePort["consumeChallenge"]>[0]): Promise<ConsumeChallengeResult> {
    return this.atomic(() => {
      const now = this.clock.now().toISOString();
      const challenge = this.state.challenges.get(input.challengeId);
      if (!challenge || challenge.delivery !== "ready" || challenge.consumedAt !== null || challenge.revokedAt !== null
          || time(challenge.expiresAt) <= time(now) || challenge.failedAttempts >= input.policy.maxCodeFailures) return { status: "invalid" };
      const mailboxKey = `verify-email:${challenge.emailRateKey}`;
      if (!this.available(mailboxKey, now, input.policy.rateWindowMs, input.policy.maxVerificationsPerEmail)) return { status: "invalid" };
      this.increment(mailboxKey, now, input.policy.rateWindowMs);
      if (challenge.codeHash !== input.codeHash) {
        this.state.challenges.set(challenge.id, { ...challenge, failedAttempts: challenge.failedAttempts + 1 });
        return { status: "invalid" };
      }
      let user = [...this.state.users.values()].find((candidate) => candidate.email === challenge.email);
      if (!user) {
        user = {
          id: input.newUserId, email: challenge.email, displayName: challenge.registrationDisplayName ?? "参赛新人", timezone: "Asia/Shanghai",
          status: "active", platformRoles: ["user"], emailVerifiedAt: now, createdAt: now, revision: 1,
        };
        this.state.users.set(user.id, user);
      }
      if (user.status !== "active") {
        this.state.challenges.set(challenge.id, { ...challenge, revokedAt: now });
        return { status: "invalid" };
      }
      this.state.challenges.set(challenge.id, { ...challenge, consumedAt: now });
      const session: SessionRecord = {
        ...input.newSession, userId: user.id, createdAt: now, authenticatedAt: now, lastSeenAt: now,
        expiresAt: new Date(time(now) + time(input.newSession.expiresAt) - time(input.newSession.createdAt)).toISOString(),
      };
      this.state.sessions.set(session.id, session);
      return { status: "verified", user: structuredClone(user), session: structuredClone(session) };
    });
  }

  async getSessionContext(tokenHash: string, _now: string): Promise<SessionContext | null> {
    return this.atomic(() => structuredClone(this.context(tokenHash)));
  }

  async revokeSessionByToken(tokenHash: string, _now: string): Promise<void> {
    await this.atomic(() => {
      const session = [...this.state.sessions.values()].find((value) => value.tokenHash === tokenHash);
      if (session && session.revokedAt === null) this.state.sessions.set(session.id, { ...session, revokedAt: this.clock.now().toISOString() });
    });
  }

  async revokeOwnSessions(input: Parameters<AuthStorePort["revokeOwnSessions"]>[0]): Promise<RevokeSessionsResult> {
    return this.atomic(() => {
      const context = this.context(input.currentTokenHash);
      if (!context) return { status: "unauthenticated" };
      const now = this.clock.now().toISOString();
      if (input.authenticatedAfter !== null && time(context.session.authenticatedAt) < time(input.authenticatedAfter) + time(now) - time(input.now)) {
        return { status: "reauthentication_required" };
      }
      let revoked = false; let currentSessionRevoked = false;
      for (const session of this.state.sessions.values()) {
        if (session.userId === context.user.id && session.revokedAt === null && time(session.expiresAt) > time(now)
          && (input.targetSessionId === null || input.targetSessionId === session.id)) {
          this.state.sessions.set(session.id, { ...session, revokedAt: now });
          revoked = true;
          if (session.id === context.session.id) currentSessionRevoked = true;
        }
      }
      return { status: "revoked", revoked, currentSessionRevoked };
    });
  }

  async listOwnSessions(tokenHash: string, _now: string): Promise<readonly SessionSummary[] | null> {
    return this.atomic(() => {
      const context = this.context(tokenHash);
      if (!context) return null;
      return structuredClone(this.sessionSummaries(context));
    });
  }

  async getOwnAccountSnapshot(tokenHash: string, _now: string): Promise<OwnAccountSnapshot | null> {
    return this.atomic(() => {
      const context = this.context(tokenHash);
      if (!context) return null;
      return structuredClone({ user: context.user, currentSession: context.session, sessions: this.sessionSummaries(context) });
    });
  }

  async updateOwnProfile(tokenHash: string, input: ProfileUpdate, _now: string): Promise<ProfileUpdateResult> {
    return this.atomic(() => {
      const context = this.context(tokenHash);
      if (!context) return { status: "unauthenticated" };
      if (context.user.revision !== input.expectedRevision) return { status: "conflict", latestRevision: context.user.revision };
      const user: AuthUserRecord = { ...context.user, displayName: input.displayName, timezone: input.timezone, revision: context.user.revision + 1 };
      this.state.users.set(user.id, user);
      return { status: "updated", user: structuredClone(user) };
    });
  }

  private context(tokenHash: string): SessionContext | null {
    const session = [...this.state.sessions.values()].find((value) => value.tokenHash === tokenHash);
    if (!session || session.revokedAt !== null || time(session.expiresAt) <= this.clock.now().getTime()) return null;
    const user = this.state.users.get(session.userId);
    if (user?.status !== "active") return null;
    const touched = { ...session, lastSeenAt: new Date(Math.max(time(session.lastSeenAt), this.clock.now().getTime())).toISOString() };
    this.state.sessions.set(session.id, touched);
    return { user, session: touched };
  }

  private sessionSummaries(context: SessionContext): SessionSummary[] {
    return [...this.state.sessions.values()]
      .filter((session) => session.userId === context.user.id && session.revokedAt === null && time(session.expiresAt) > this.clock.now().getTime())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
      .map((session) => ({
        id: session.id, createdAt: session.createdAt, authenticatedAt: session.authenticatedAt,
        expiresAt: session.expiresAt, current: session.id === context.session.id, lastSeenAt: session.lastSeenAt,
      }));
  }

  private available(key: string, now: string, windowMs: number, max: number, cooldownMs = 0): boolean {
    const rate = this.state.rates.get(key);
    if (!rate) return true;
    const count = time(now) - time(rate.startedAt) >= windowMs ? 0 : rate.count;
    return count < max && (rate.lastAt === null || time(now) - time(rate.lastAt) >= cooldownMs);
  }

  private increment(key: string, now: string, windowMs: number): void {
    const rate = this.state.rates.get(key);
    const reset = !rate || time(now) - time(rate.startedAt) >= windowMs;
    this.state.rates.set(key, { startedAt: reset ? now : rate.startedAt, count: reset ? 1 : rate.count + 1, lastAt: now });
  }

  private async atomic<T>(work: () => T | Promise<T>): Promise<T> {
    const prior = this.tail; const released = deferred<void>(); this.tail = released.promise;
    await prior;
    const before = structuredClone(this.state);
    try { return await work(); }
    catch (error) { this.state = before; throw error; }
    finally { released.resolve(); }
  }
}
