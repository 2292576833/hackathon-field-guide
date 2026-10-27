import { createHash, randomBytes } from "node:crypto";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { requireProjectAccess } from "./permissions.ts";
import { GitHubHttpError } from "./github-http.ts";
import type { GitHubCredentialPort, RepositoryTarget, UserCredential } from "./types.ts";
import type { AuthorizationDependencies, GitHubIdentity, GitHubTokenSet, GitHubUserCredentialProvider, StoredAuthorizationState, StoredGitHubCredential } from "./authorization-types.ts";

const NONCE = /^[A-Za-z0-9_-]{43}$/u;
const ACCESS = /^ghu_[A-Za-z0-9]{20,512}$/u;
const REFRESH = /^ghr_[A-Za-z0-9]{20,512}$/u;
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const nonce = (): string => randomBytes(32).toString("base64url");
const stateContext = (s: StoredAuthorizationState): string => JSON.stringify(["github-app-state", s.userId, s.appId, s.stateHash]);
const tokenContext = (c: Pick<StoredGitHubCredential, "userId" | "appId" | "githubUserId">): string => JSON.stringify(["github-app-tokens", c.userId, c.appId, c.githubUserId]);
function authRequired(): DomainError { return new DomainError("GITHUB_AUTHORIZATION_REQUIRED", "请重新连接 GitHub 账号。", { status: 401, recoveryAction: "reauthorize_github" }); }
function stateInvalid(): DomainError { return new DomainError("GITHUB_AUTHORIZATION_STATE_INVALID", "授权流程已过期或不属于当前会话，请重新连接。", { status: 400, recoveryAction: "reauthorize_github" }); }
function identityChanged(): DomainError { return new DomainError("GITHUB_IDENTITY_MISMATCH", "GitHub 账号与本站绑定不一致，请先解除绑定后重新连接。", { status: 409, recoveryAction: "revoke_then_reauthorize_github" }); }
function actorUser(actor: Actor): string {
  if (!actor || typeof actor.userId !== "string" || !actor.userId || actor.userId.length > 256 || /[\u0000-\u001f\u007f]/u.test(actor.userId)) throw new DomainError("UNAUTHENTICATED", "请先登录。", { status: 401 });
  return actor.userId;
}
function validateIdentity(identity: GitHubIdentity): GitHubIdentity {
  if (!identity || !Number.isSafeInteger(identity.id) || identity.id < 1 || typeof identity.login !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/u.test(identity.login)) throw identityChanged();
  return { id: identity.id, login: identity.login, profileUrl: `https://github.com/${encodeURIComponent(identity.login)}` };
}
function validateTokens(tokens: GitHubTokenSet, now: Date): GitHubTokenSet {
  if (!tokens || typeof tokens.accessToken !== "string" || !ACCESS.test(tokens.accessToken) || typeof tokens.refreshToken !== "string" || !REFRESH.test(tokens.refreshToken) || typeof tokens.accessExpiresAt !== "string" || typeof tokens.refreshExpiresAt !== "string" || !Number.isFinite(Date.parse(tokens.accessExpiresAt)) || !Number.isFinite(Date.parse(tokens.refreshExpiresAt)) || Date.parse(tokens.accessExpiresAt) <= now.getTime() || Date.parse(tokens.refreshExpiresAt) <= Date.parse(tokens.accessExpiresAt)) throw authRequired();
  return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, accessExpiresAt: new Date(tokens.accessExpiresAt).toISOString(), refreshExpiresAt: new Date(tokens.refreshExpiresAt).toISOString() };
}
export interface AuthorizationCookie { name: string; value: string; path: string; maxAge: number; secure: boolean }
export function authorizationCookieName(flow: StoredAuthorizationState["flow"], state: string): string {
  if (!NONCE.test(state)) throw stateInvalid();
  return `hh_github_${flow === "authorization" ? "oauth" : "install"}_${state.slice(0, 16)}`;
}

/** Server-only user authorization. Browser responses never receive credentials or the PKCE verifier. */
export class GitHubAuthorizationService implements GitHubCredentialPort, GitHubUserCredentialProvider {
  private readonly d: AuthorizationDependencies;
  private readonly ttl: number;
  private readonly skew: number;
  private readonly origin: string;
  private readonly callback: URL;
  private readonly installationCallback: URL;
  constructor(d: AuthorizationDependencies) {
    this.d = { ...d, options: { ...d.options } };
    this.ttl = d.options.stateTtlSeconds ?? 600; this.skew = d.options.refreshSkewSeconds ?? 60;
    try {
      const origin = new URL(d.options.origin); this.callback = new URL(d.options.callbackUrl);
      const local = origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
      if ((!local && origin.protocol !== "https:") || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash || this.callback.origin !== origin.origin || this.callback.username || this.callback.password || this.callback.search || this.callback.hash || !Number.isSafeInteger(d.options.appId) || d.options.appId < 1 || typeof d.options.clientId !== "string" || !/^[A-Za-z0-9_.-]{1,200}$/u.test(d.options.clientId) || typeof d.options.clientSecret !== "string" || !/^[A-Za-z0-9_-]{1,512}$/u.test(d.options.clientSecret) || typeof d.options.appSlug !== "string" || !/^[A-Za-z0-9-]{1,100}$/u.test(d.options.appSlug) || !Number.isSafeInteger(this.ttl) || this.ttl < 60 || this.ttl > 900 || !Number.isSafeInteger(this.skew) || this.skew < 0 || this.skew > 300) throw new Error();
      this.origin = origin.origin; this.installationCallback = new URL("/api/v1/github/installation/callback", origin);
    } catch { throw new DomainError("GITHUB_INVALID_CONFIG", "GitHub App 服务配置无效。", { status: 500 }); }
  }
  private async project(actor: Actor, input: { projectId?: string }): Promise<string | null> {
    actorUser(actor);
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => k !== "projectId") || (input.projectId !== undefined && (typeof input.projectId !== "string" || !input.projectId || input.projectId.length > 256))) throw new DomainError("INVALID_INPUT", "请提供有效的项目 ID。");
    if (input.projectId) await requireProjectAccess(this.d.access, actor, input.projectId);
    return input.projectId ?? null;
  }
  private async begin(actor: Actor, projectId: string | null, flow: StoredAuthorizationState["flow"]): Promise<{ state: string; verifier: string; expiresAt: string; cookie: AuthorizationCookie }> {
    const state = nonce(), verifier = nonce(), browser = nonce(), now = this.d.clock.now();
    const record: StoredAuthorizationState = { stateHash: hash(state), userId: actorUser(actor), appId: this.d.options.appId, browserHash: hash(browser), encryptedVerifier: { keyId: "", iv: "", tag: "", data: "" }, projectId, returnTo: projectId ? `/app/projects/${encodeURIComponent(projectId)}/delivery` : "/app/account", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + this.ttl * 1000).toISOString(), authorizationEpoch: await this.d.store.getAuthorizationEpoch(actor.userId, this.d.options.appId), flow };
    record.encryptedVerifier = this.d.cipher.encrypt({ verifier }, stateContext(record));
    await this.d.store.insertState(record);
    return { state, verifier, expiresAt: record.expiresAt, cookie: { name: authorizationCookieName(flow, state), value: browser, path: (flow === "authorization" ? this.callback : this.installationCallback).pathname, maxAge: this.ttl, secure: this.origin.startsWith("https:") } };
  }
  async start(actor: Actor, input: { projectId?: string } = {}): Promise<{ authorizationUrl: string; expiresAt: string; cookie: AuthorizationCookie }> {
    const s = await this.begin(actor, await this.project(actor, input), "authorization");
    const url = new URL("https://github.com/login/oauth/authorize");
    url.search = new URLSearchParams({ client_id: this.d.options.clientId, redirect_uri: this.callback.href, state: s.state, code_challenge: createHash("sha256").update(s.verifier).digest("base64url"), code_challenge_method: "S256", scope: "offline_access" }).toString();
    return { authorizationUrl: url.href, expiresAt: s.expiresAt, cookie: s.cookie };
  }
  private async consume(actor: Actor, state: string, browserNonce: string, flow: StoredAuthorizationState["flow"]): Promise<StoredAuthorizationState> {
    actorUser(actor);
    if (typeof state !== "string" || !NONCE.test(state) || typeof browserNonce !== "string" || !NONCE.test(browserNonce)) throw stateInvalid();
    const record = await this.d.store.consumeState({ stateHash: hash(state), userId: actor.userId, appId: this.d.options.appId, browserHash: hash(browserNonce), now: this.d.clock.now().toISOString(), flow });
    if (!record || record.flow !== flow || await this.d.store.getAuthorizationEpoch(actor.userId, this.d.options.appId) !== record.authorizationEpoch) throw stateInvalid();
    if (record.projectId) await requireProjectAccess(this.d.access, actor, record.projectId);
    return record;
  }
  private async cleanToken(token: string): Promise<void> { try { await this.d.http.revokeToken(token); } catch { /* Cleanup uncertainty never exposes provider errors or reactivates local credentials. */ } }
  async complete(actor: Actor, input: { state: string; code?: string; error?: string }, browserNonce: string): Promise<{ status: "bound"; identity: GitHubIdentity; returnTo: string }> {
    actorUser(actor);
    const previous = await this.d.store.getCredential(actor.userId, this.d.options.appId);
    const record = await this.consume(actor, input.state, browserNonce, "authorization");
    if (input.error !== undefined) throw new DomainError("GITHUB_AUTHORIZATION_CANCELLED", "GitHub 授权未完成，请重新连接。", { status: 400, recoveryAction: "reauthorize_github" });
    if (typeof input.code !== "string" || !/^[A-Za-z0-9._~-]{1,512}$/u.test(input.code)) throw new DomainError("GITHUB_AUTHORIZATION_CODE_INVALID", "GitHub 授权未完成，请重新连接。", { status: 400 });
    const secret = this.d.cipher.decrypt<{ verifier: string }>(record.encryptedVerifier, stateContext(record));
    if (!secret || typeof secret.verifier !== "string" || !NONCE.test(secret.verifier)) throw stateInvalid();
    const minted = await this.d.http.exchangeCode({ code: input.code, codeVerifier: secret.verifier, redirectUri: this.callback.href });
    try {
      const tokens = validateTokens(minted, this.d.clock.now()), identity = validateIdentity(await this.d.http.getIdentity(tokens.accessToken));
      if (previous && previous.status !== "revoked" && previous.githubUserId !== identity.id) throw identityChanged();
      if (record.projectId) await requireProjectAccess(this.d.access, actor, record.projectId);
      const credential: StoredGitHubCredential = { userId: actor.userId, appId: this.d.options.appId, githubUserId: identity.id, githubLogin: identity.login, encryptedTokens: null, accessExpiresAt: tokens.accessExpiresAt, refreshExpiresAt: tokens.refreshExpiresAt, status: "active", revision: (previous?.revision ?? 0) + 1, refreshLeaseUntil: null, checkedAt: this.d.clock.now().toISOString() };
      credential.encryptedTokens = this.d.cipher.encrypt(tokens, tokenContext(credential));
      await this.d.store.saveCredential(credential, previous?.revision ?? null, record.authorizationEpoch);
      return { status: "bound", identity, returnTo: record.returnTo };
    } catch (error) { if (typeof minted?.accessToken === "string" && ACCESS.test(minted.accessToken)) await this.cleanToken(minted.accessToken); throw error; }
  }
  async status(actor: Actor) {
    actorUser(actor); const c = await this.d.store.getCredential(actor.userId, this.d.options.appId);
    if (!c || c.status === "revoked") return { status: "not_connected" as const, identity: null, accessExpiresAt: null, refreshExpiresAt: null };
    return { status: c.status === "active" ? "bound" as const : c.status, identity: { id: c.githubUserId, login: c.githubLogin, profileUrl: `https://github.com/${encodeURIComponent(c.githubLogin)}` }, accessExpiresAt: c.accessExpiresAt, refreshExpiresAt: c.refreshExpiresAt };
  }
  private async requireReauthorization(c: StoredGitHubCredential): Promise<void> {
    try { await this.d.store.saveCredential({ ...c, revision: c.revision + 1, encryptedTokens: null, status: "reauthorize_required", refreshLeaseUntil: null, checkedAt: this.d.clock.now().toISOString() }, c.revision); }
    catch (error) { if (!(error instanceof DomainError && error.code === "VERSION_CONFLICT")) throw error; }
  }
  async getAuthorizationCredential(actor: Actor): Promise<UserCredential> {
    actorUser(actor); let c = await this.d.store.getCredential(actor.userId, this.d.options.appId);
    if (!c || c.status === "revoked" || c.status === "reauthorize_required" || !c.encryptedTokens) throw authRequired();
    const now = this.d.clock.now();
    if (c.status === "refreshing") {
      if (!c.refreshLeaseUntil || Date.parse(c.refreshLeaseUntil) <= now.getTime()) { await this.requireReauthorization(c); throw authRequired(); }
      throw new DomainError("GITHUB_REFRESH_IN_PROGRESS", "GitHub 授权正在刷新，请稍后重试。", { status: 503, recoveryAction: "retry_later" });
    }
    let tokens: GitHubTokenSet;
    try { tokens = this.d.cipher.decrypt<GitHubTokenSet>(c.encryptedTokens, tokenContext(c)); }
    catch { await this.requireReauthorization(c); throw authRequired(); }
    if (!tokens || typeof tokens.accessToken !== "string" || !ACCESS.test(tokens.accessToken) || typeof tokens.refreshToken !== "string" || !REFRESH.test(tokens.refreshToken) || tokens.accessExpiresAt !== c.accessExpiresAt || tokens.refreshExpiresAt !== c.refreshExpiresAt || !Number.isFinite(Date.parse(c.accessExpiresAt)) || !Number.isFinite(Date.parse(c.refreshExpiresAt))) { await this.requireReauthorization(c); throw authRequired(); }
    if (Date.parse(c.accessExpiresAt) <= now.getTime() + this.skew * 1000) {
      if (Date.parse(c.refreshExpiresAt) <= now.getTime()) { await this.requireReauthorization(c); throw authRequired(); }
      const claim = await this.d.store.claimRefresh(actor.userId, c.appId, c.revision, new Date(now.getTime() + 120_000).toISOString());
      if (!claim) throw new DomainError("GITHUB_REFRESH_IN_PROGRESS", "GitHub 授权已更新，请稍后重试。", { status: 503 });
      let refreshed: GitHubTokenSet | undefined;
      try {
        refreshed = validateTokens(await this.d.http.refreshToken(tokens.refreshToken), this.d.clock.now());
        if (refreshed.refreshToken === tokens.refreshToken) throw authRequired();
        const identity = validateIdentity(await this.d.http.getIdentity(refreshed.accessToken));
        if (identity.id !== claim.githubUserId) throw identityChanged();
        const next: StoredGitHubCredential = { ...claim, githubLogin: identity.login, encryptedTokens: null, status: "active", revision: claim.revision + 1, refreshLeaseUntil: null, accessExpiresAt: refreshed.accessExpiresAt, refreshExpiresAt: refreshed.refreshExpiresAt, checkedAt: this.d.clock.now().toISOString() };
        next.encryptedTokens = this.d.cipher.encrypt(refreshed, tokenContext(next));
        await this.d.store.saveCredential(next, claim.revision); c = next; tokens = refreshed;
      } catch { if (refreshed) await this.cleanToken(refreshed.accessToken); await this.requireReauthorization(claim); throw authRequired(); }
    } else {
      try { if (validateIdentity(await this.d.http.getIdentity(tokens.accessToken)).id !== c.githubUserId) { await this.requireReauthorization(c); throw identityChanged(); } }
      catch (error) { if (error instanceof GitHubHttpError && error.providerStatus === 401) { await this.requireReauthorization(c); throw authRequired(); } throw error; }
    }
    const current = await this.d.store.getCredential(actor.userId, c.appId);
    if (!current || current.status !== "active" || current.revision !== c.revision) throw authRequired();
    return { token: tokens.accessToken, tokenKind: "github_app_user", websiteUserId: actor.userId, githubUserId: c.githubUserId };
  }
  async getUserCredential(actor: Actor, target: RepositoryTarget): Promise<UserCredential> {
    if (!target || target.appId !== this.d.options.appId) throw new DomainError("GITHUB_APP_MISMATCH", "仓库不属于配置的 GitHub App。", { status: 403 });
    return this.getAuthorizationCredential(actor);
  }
  async listInstallations(actor: Actor) {
    const credential = await this.getAuthorizationCredential(actor);
    return (await this.d.http.listInstallations(credential.token)).filter(i => i.appId === this.d.options.appId && !i.suspended).map(i => ({ id: i.id, appId: i.appId, accountLogin: i.accountLogin, accountType: i.accountType, repositorySelection: i.repositorySelection, permissions: Object.fromEntries(Object.entries(i.permissions).filter(([k, v]) => ["metadata", "contents", "pull_requests", "administration", "repository_creation"].includes(k) && ["read", "write"].includes(v))), suspended: false }));
  }
  async listRepositories(actor: Actor, installationId: number) {
    if (!Number.isSafeInteger(installationId) || installationId < 1) throw new DomainError("INVALID_INSTALLATION", "请选择有效的 GitHub 安装。");
    const credential = await this.getAuthorizationCredential(actor), installation = (await this.d.http.listInstallations(credential.token)).find(i => i.id === installationId && i.appId === this.d.options.appId && !i.suspended);
    if (!installation) throw new DomainError("GITHUB_INSTALLATION_NOT_ACCESSIBLE", "当前 GitHub 账号不能访问该 App 安装。", { status: 403 });
    return (await this.d.http.listRepositories(credential.token, installation)).filter(r => r.appId === this.d.options.appId && r.installationId === installationId).map(r => ({ repositoryId: r.repositoryId, owner: r.owner, name: r.name, installationId: r.installationId, appId: r.appId, defaultBranch: r.defaultBranch, url: `https://github.com/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}`, private: r.private, userCanPush: r.userCanPush, contentsWrite: r.contentsWrite, pullRequestsWrite: r.pullRequestsWrite, archived: r.archived, disabled: r.disabled }));
  }
  async startInstallation(actor: Actor, input: { projectId?: string } = {}): Promise<{ installationUrl: string; expiresAt: string; cookie: AuthorizationCookie }> {
    const projectId = await this.project(actor, input); await this.getAuthorizationCredential(actor);
    const s = await this.begin(actor, projectId, "installation"), url = new URL(`https://github.com/apps/${encodeURIComponent(this.d.options.appSlug)}/installations/new`);
    url.searchParams.set("state", s.state); return { installationUrl: url.href, expiresAt: s.expiresAt, cookie: s.cookie };
  }
  async completeInstallation(actor: Actor, input: { state: string; installationId: number }, browserNonce: string): Promise<{ returnTo: string; installationId: number }> {
    const record = await this.consume(actor, input.state, browserNonce, "installation");
    if (!Number.isSafeInteger(input.installationId) || input.installationId < 1) throw new DomainError("INVALID_INSTALLATION", "GitHub 安装未完成。", { status: 400 });
    const installations = await this.listInstallations(actor);
    if (!installations.some(i => i.id === input.installationId)) throw new DomainError("GITHUB_INSTALLATION_NOT_ACCESSIBLE", "GitHub 安装不属于当前用户和 App。", { status: 403 });
    return { returnTo: record.returnTo, installationId: input.installationId };
  }
  async revoke(actor: Actor): Promise<{ status: "revoked"; remoteStatus: "revoked" | "not_attempted" | "unknown" }> {
    actorUser(actor); let token: string | undefined, epoch: number | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const c = await this.d.store.getCredential(actor.userId, this.d.options.appId);
      token = undefined;
      if (c?.encryptedTokens) { try { const stored = this.d.cipher.decrypt<GitHubTokenSet>(c.encryptedTokens, tokenContext(c)); if (ACCESS.test(stored.accessToken)) token = stored.accessToken; } catch { /* Local revocation remains possible without a decryption key. */ } }
      try { epoch = await this.d.store.revokeCredential(actor.userId, this.d.options.appId, c?.revision ?? null); break; }
      catch (error) { if (!(error instanceof DomainError && error.code === "VERSION_CONFLICT") || attempt === 2) throw error; }
    }
    let remoteStatus: "revoked" | "not_attempted" | "unknown" = "not_attempted";
    try { if (token) { try { await this.d.http.revokeGrant(token); remoteStatus = "revoked"; } catch { remoteStatus = "unknown"; } } }
    finally { if (epoch !== undefined) await this.d.store.finishRevocation(actor.userId, this.d.options.appId, epoch); }
    return { status: "revoked", remoteStatus };
  }
}
