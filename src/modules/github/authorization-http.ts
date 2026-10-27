import { Buffer } from "node:buffer";
import type { Clock } from "../../shared/contracts.ts";
import { GITHUB_API_VERSION, GitHubHttpError } from "./github-http.ts";
import type { CreatedRepository, DiscoveredRepository, GitHubAppOptions, GitHubAuthorizationHttpPort, GitHubIdentity, GitHubInstallation, GitHubTokenSet } from "./authorization-types.ts";

// Official contracts checked 2026-10-08; no live credentials or repository writes were used.
// https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
// https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens
// https://docs.github.com/en/rest/apps/oauth-applications?apiVersion=2026-03-10
// https://docs.github.com/en/rest/apps/installations?apiVersion=2026-03-10
// https://docs.github.com/en/rest/repos/repos?apiVersion=2026-03-10#create-a-repository-for-the-authenticated-user
// https://docs.github.com/en/rest/git/refs?apiVersion=2026-03-10#get-a-reference

export interface GitHubAuthorizationHttpAdapterOptions {
  fetch?: typeof globalThis.fetch;
  clock?: Clock;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxPages?: number;
}
type ObjectValue = Record<string, unknown>;
const ACCESS_TOKEN = /^ghu_[A-Za-z0-9]{20,512}$/;
const REFRESH_TOKEN = /^ghr_[A-Za-z0-9]{20,512}$/;
const SHA = /^[a-f0-9]{40}$/i;

function providerError(unknown = false): GitHubHttpError {
  return new GitHubHttpError(unknown ? "GITHUB_OUTCOME_UNKNOWN" : "GITHUB_INVALID_RESPONSE", "GitHub 返回的结果无法安全核对。", { outcomeUnknown: unknown, recoveryAction: unknown ? "reauthorize_or_reconcile" : "sync_github" });
}
function obj(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw providerError();
  return value as ObjectValue;
}
function id(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw providerError();
  return value;
}
function login(value: unknown): string {
  if (typeof value !== "string" || value.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(value)) throw providerError();
  return value;
}
function name(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 100 || value === "." || value === ".." || !/^[A-Za-z0-9_.-]+$/.test(value)) throw providerError();
  return value;
}
function branch(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 240 || value === "@" || value.startsWith("-") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".") || value.includes("..") || value.includes("//") || value.includes("@{") || /[\x00-\x20\x7f~^:?*\[\\]/.test(value) || value.split("/").some(part => part.startsWith(".") || part.endsWith(".lock")) || Buffer.from(value, "utf8").toString("utf8") !== value) throw providerError();
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw providerError();
  return value;
}
function token(value: unknown, refresh = false): string {
  if (typeof value !== "string" || !(refresh ? REFRESH_TOKEN : ACCESS_TOKEN).test(value)) throw new GitHubHttpError("GITHUB_APP_USER_TOKEN_REQUIRED", "需要有效的 GitHub App 用户授权。", { status: 401, recoveryAction: "reauthorize_github" });
  return value;
}
function permissionProjection(value: unknown): Record<string, string> {
  const source = obj(value);
  const result: Record<string, string> = {};
  for (const key of ["metadata", "contents", "pull_requests", "administration", "repository_creation"]) {
    if (source[key] === "read" || source[key] === "write") result[key] = source[key] as string;
  }
  return result;
}

/** Server-only adapter: fixed hosts, expiring GitHub App user tokens, and no automatic retries. */
export class GitHubAppAuthorizationHttpAdapter implements GitHubAuthorizationHttpPort {
  private readonly options: GitHubAppOptions;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly clock: Clock;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxPages: number;

  constructor(options: GitHubAppOptions, transport: GitHubAuthorizationHttpAdapterOptions = {}) {
    this.options = { ...options };
    this.fetcher = transport.fetch ?? globalThis.fetch;
    this.clock = transport.clock ?? { now: () => new Date() };
    this.timeoutMs = transport.timeoutMs ?? 15_000;
    this.maxResponseBytes = transport.maxResponseBytes ?? 1_048_576;
    this.maxPages = transport.maxPages ?? 100;
    try {
      const origin = new URL(options.origin);
      const callback = new URL(options.callbackUrl);
      const localHttp = origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
      if ((!localHttp && origin.protocol !== "https:") || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash || callback.origin !== origin.origin || callback.username || callback.password || callback.hash || !Number.isSafeInteger(options.appId) || options.appId <= 0 || typeof options.clientId !== "string" || !/^[A-Za-z0-9_.-]{1,200}$/.test(options.clientId) || typeof options.clientSecret !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(options.clientSecret) || typeof options.appSlug !== "string" || !/^[A-Za-z0-9-]{1,100}$/.test(options.appSlug)) throw new Error("config");
      for (const value of [this.timeoutMs, this.maxResponseBytes, this.maxPages]) if (!Number.isSafeInteger(value) || value < 1) throw new Error("config");
      if (this.maxPages > 100) throw new Error("config");
    } catch { throw new GitHubHttpError("GITHUB_INVALID_CONFIG", "GitHub App 服务配置无效。", { status: 500 }); }
  }

  private classify(response: Response, write: boolean): GitHubHttpError {
    const retryAfter = response.headers.get("retry-after");
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = response.headers.get("x-ratelimit-reset");
    if (response.status === 429 || (response.status === 403 && (retryAfter !== null || remaining === "0"))) {
      let millis: number | undefined;
      if (retryAfter !== null && /^\d+$/.test(retryAfter)) millis = this.clock.now().getTime() + Number(retryAfter) * 1000;
      if (remaining === "0" && reset !== null && /^\d+$/.test(reset)) millis = Math.max(millis ?? 0, Number(reset) * 1000);
      const retryAt = millis !== undefined && Number.isFinite(millis) && Math.abs(millis) <= 8.64e15 ? new Date(millis).toISOString() : undefined;
      return new GitHubHttpError("GITHUB_RATE_LIMITED", "GitHub 请求额度暂时用尽，请等待后再核对。", { status: 429, providerStatus: response.status, retryAt, recoveryAction: "wait_then_reconcile" });
    }
    if (response.status >= 500 || response.status === 408) return new GitHubHttpError(write ? "GITHUB_OUTCOME_UNKNOWN" : "GITHUB_SERVICE_UNAVAILABLE", "GitHub 暂时无法确认操作结果。", { outcomeUnknown: write, providerStatus: response.status, recoveryAction: write ? "reauthorize_or_reconcile" : "sync_github" });
    const codes: Record<number, [string, string, number]> = {
      401: ["GITHUB_CREDENTIAL_EXPIRED", "GitHub 用户授权已失效，请重新连接。", 401],
      403: ["GITHUB_PERMISSION_DENIED", "GitHub 当前权限不允许此操作，请检查应用授权。", 403],
      404: ["GITHUB_NOT_FOUND", "GitHub 对象不存在或当前授权无法访问。", 404],
      409: ["GITHUB_CONFLICT", "GitHub 状态发生变化，请重新核对。", 409],
      422: ["GITHUB_VALIDATION_FAILED", "GitHub 拒绝此请求，请检查输入与仓库状态。", 422],
    };
    const [code, message, status] = codes[response.status] ?? ["GITHUB_REQUEST_REJECTED", "GitHub 未接受此请求。", 503];
    return new GitHubHttpError(code, message, { status, providerStatus: response.status, recoveryAction: "review_github_status" });
  }

  private async boundedJson(response: Response, signal: AbortSignal, write: boolean): Promise<unknown> {
    const length = response.headers.get("content-length");
    if (length !== null && /^\d+$/.test(length) && Number(length) > this.maxResponseBytes) { await response.body?.cancel(); throw providerError(write); }
    if (!response.body) throw providerError(write);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let total = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const item = await reader.read();
        if (item.done) break;
        total += item.value.byteLength;
        if (total > this.maxResponseBytes) { await reader.cancel(); throw providerError(write); }
        chunks.push(item.value);
      }
      try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total))) as unknown; } catch { throw providerError(write); }
    } finally { reader.releaseLock(); }
  }

  private async request(input: { host?: "oauth"; path: string; method?: "POST" | "DELETE"; authorization?: string; body?: unknown; expected?: number; missing?: boolean; uninitialized?: boolean }): Promise<{ data: unknown; headers: Headers } | null> {
    const method = input.method ?? "GET";
    const write = method !== "GET";
    const expected = input.expected ?? (method === "DELETE" ? 204 : 200);
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const work = async (): Promise<{ data: unknown; headers: Headers } | null> => {
      const response = await this.fetcher(`${input.host === "oauth" ? "https://github.com" : "https://api.github.com"}${input.path}`, {
        method, redirect: "error", cache: "no-store", signal: controller.signal,
        headers: { Accept: input.host === "oauth" ? "application/json" : "application/vnd.github+json", "X-GitHub-Api-Version": GITHUB_API_VERSION, "User-Agent": "hackathon-field-guide", ...(input.authorization ? { Authorization: input.authorization } : {}), ...(input.body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
      });
      if (!write && ((response.status === 404 && input.missing) || (response.status === 409 && input.uninitialized))) { await response.body?.cancel(); return null; }
      if (response.status < 200 || response.status >= 300) { await response.body?.cancel(); throw this.classify(response, write); }
      if (response.status !== expected) { await response.body?.cancel(); throw providerError(write); }
      if (expected === 204) { await response.body?.cancel(); return { data: null, headers: response.headers }; }
      return { data: await this.boundedJson(response, controller.signal, write), headers: response.headers };
    };
    try {
      return await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, this.timeoutMs); })]);
    } catch (error) {
      if (error instanceof GitHubHttpError) throw error;
      throw new GitHubHttpError(write ? "GITHUB_OUTCOME_UNKNOWN" : "GITHUB_SERVICE_UNAVAILABLE", write ? "GitHub 操作结果尚未确认，请先核对或重新授权。" : "暂时无法连接 GitHub。", { outcomeUnknown: write, recoveryAction: write ? "reauthorize_or_reconcile" : "sync_github" });
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  private tokenSet(data: unknown, refresh: boolean): GitHubTokenSet {
    let response: ObjectValue;
    try { response = obj(data); } catch { throw providerError(true); }
    if (typeof response.error === "string") throw new GitHubHttpError(refresh ? "GITHUB_REFRESH_REJECTED" : "GITHUB_AUTHORIZATION_REJECTED", "GitHub 未接受授权凭证，请重新完成用户授权。", { status: 401, recoveryAction: "reauthorize_github" });
    try {
      const accessToken = token(response.access_token);
      const refreshToken = token(response.refresh_token, true);
      if (response.token_type !== "bearer" || (response.scope !== "" && response.scope !== "offline_access") || typeof response.expires_in !== "number" || !Number.isSafeInteger(response.expires_in) || response.expires_in < 1 || response.expires_in > 31_536_000 || typeof response.refresh_token_expires_in !== "number" || !Number.isSafeInteger(response.refresh_token_expires_in) || response.refresh_token_expires_in < response.expires_in || response.refresh_token_expires_in > 31_536_000) throw providerError(true);
      const now = this.clock.now().getTime();
      const accessExpiresAt = new Date(now + response.expires_in * 1000).toISOString();
      const refreshExpiresAt = new Date(now + response.refresh_token_expires_in * 1000).toISOString();
      return { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt };
    } catch { throw providerError(true); }
  }

  async exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<GitHubTokenSet> {
    if (!input || typeof input.code !== "string" || input.code.length < 1 || input.code.length > 512 || /\s/.test(input.code) || typeof input.codeVerifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier) || input.redirectUri !== this.options.callbackUrl) throw new GitHubHttpError("GITHUB_INVALID_AUTHORIZATION_INPUT", "授权回调参数无效，请重新连接。", { status: 422 });
    const result = await this.request({ host: "oauth", path: "/login/oauth/access_token", method: "POST", body: { client_id: this.options.clientId, client_secret: this.options.clientSecret, code: input.code, code_verifier: input.codeVerifier, redirect_uri: input.redirectUri } });
    try { return this.tokenSet(result?.data, false); } catch (error) { if (error instanceof GitHubHttpError && !error.outcomeUnknown) throw error; throw providerError(true); }
  }

  async refreshToken(refreshToken: string): Promise<GitHubTokenSet> {
    token(refreshToken, true);
    const result = await this.request({ host: "oauth", path: "/login/oauth/access_token", method: "POST", body: { client_id: this.options.clientId, client_secret: this.options.clientSecret, grant_type: "refresh_token", refresh_token: refreshToken } });
    const next = this.tokenSet(result?.data, true);
    if (next.refreshToken === refreshToken) throw providerError(true);
    return next;
  }

  async revokeGrant(accessToken: string): Promise<void> {
    token(accessToken);
    const basic = Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`, "utf8").toString("base64");
    await this.request({ path: `/applications/${encodeURIComponent(this.options.clientId)}/grant`, method: "DELETE", authorization: `Basic ${basic}`, body: { access_token: accessToken } });
  }

  async revokeToken(accessToken: string): Promise<void> {
    token(accessToken);
    const basic = Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`, "utf8").toString("base64");
    await this.request({ path: `/applications/${encodeURIComponent(this.options.clientId)}/token`, method: "DELETE", authorization: `Basic ${basic}`, body: { access_token: accessToken } });
  }

  async getIdentity(accessToken: string): Promise<GitHubIdentity> {
    token(accessToken);
    const result = await this.request({ path: "/user", authorization: `Bearer ${accessToken}` });
    const user = obj(result?.data);
    if (user.type !== "User") throw providerError();
    const githubLogin = login(user.login);
    return { id: id(user.id), login: githubLogin, profileUrl: `https://github.com/${githubLogin}` };
  }

  private async pages(accessToken: string, path: string, key: "installations" | "repositories"): Promise<unknown[]> {
    token(accessToken);
    const items: unknown[] = [];
    for (let page = 1; page <= this.maxPages; page++) {
      const result = await this.request({ path: `${path}?per_page=100&page=${page}`, authorization: `Bearer ${accessToken}` });
      const root = obj(result?.data);
      const batch = root[key];
      if (!Array.isArray(batch) || batch.length > 100 || typeof root.total_count !== "number" || !Number.isSafeInteger(root.total_count) || root.total_count < 0) throw providerError();
      items.push(...batch);
      const next = /(?:^|,)\s*<[^>]+>\s*;\s*rel="next"/.test(result?.headers.get("link") ?? "");
      if (!next && items.length >= root.total_count) return items;
      if (batch.length === 0) throw providerError();
    }
    throw new GitHubHttpError("GITHUB_PAGINATION_LIMIT", "GitHub 授权范围过大，暂时无法完整核对。", { status: 503 });
  }

  async listInstallations(accessToken: string): Promise<GitHubInstallation[]> {
    const data = await this.pages(accessToken, "/user/installations", "installations");
    const installations: GitHubInstallation[] = [];
    for (const value of data) {
      const installation = obj(value);
      if (installation.app_id !== this.options.appId || installation.suspended_at !== null) continue;
      const account = obj(installation.account);
      if (account.type !== "User" && account.type !== "Organization") continue;
      if (installation.repository_selection !== "all" && installation.repository_selection !== "selected") throw providerError();
      installations.push({ id: id(installation.id), appId: this.options.appId, accountLogin: login(account.login), accountType: account.type, repositorySelection: installation.repository_selection, permissions: permissionProjection(installation.permissions), suspended: false });
    }
    return installations;
  }

  async listRepositories(accessToken: string, installation: GitHubInstallation): Promise<DiscoveredRepository[]> {
    if (!installation || installation.appId !== this.options.appId || installation.suspended || !Number.isSafeInteger(installation.id) || installation.id <= 0) throw new GitHubHttpError("GITHUB_INSTALLATION_REVOKED", "应用安装不在当前可用授权范围。", { status: 403 });
    const appPermissions = permissionProjection(installation.permissions);
    const values = await this.pages(accessToken, `/user/installations/${installation.id}/repositories`, "repositories");
    return values.map(value => {
      const repository = obj(value); const owner = login(obj(repository.owner).login); const repositoryName = name(repository.name);
      const archived = bool(repository.archived), disabled = bool(repository.disabled);
      const userCanPush = obj(repository.permissions).push === true && !archived && !disabled;
      return { repositoryId: id(repository.id), owner, name: repositoryName, installationId: installation.id, appId: this.options.appId, defaultBranch: branch(repository.default_branch), url: `https://github.com/${owner}/${repositoryName}`, private: bool(repository.private), userCanPush, contentsWrite: userCanPush && appPermissions.contents === "write", pullRequestsWrite: userCanPush && appPermissions.pull_requests === "write", archived, disabled };
    });
  }

  private repositoryProjection(value: unknown, expectedOwner: string, expectedName: string): CreatedRepository {
    const repository = obj(value);
    const owner = login(obj(repository.owner).login), repositoryName = name(repository.name);
    if (owner.toLowerCase() !== expectedOwner.toLowerCase() || repositoryName.toLowerCase() !== expectedName.toLowerCase() || (repository.description !== null && typeof repository.description !== "string")) throw providerError();
    return { repositoryId: id(repository.id), owner, name: repositoryName, url: `https://github.com/${owner}/${repositoryName}`, private: bool(repository.private), defaultBranch: branch(repository.default_branch), initialized: false, description: typeof repository.description === "string" ? repository.description : "" };
  }

  async getRepository(accessToken: string, owner: string, repositoryName: string): Promise<CreatedRepository | null> {
    token(accessToken);
    try { login(owner); name(repositoryName); } catch { throw new GitHubHttpError("GITHUB_INVALID_INPUT", "仓库名称无效。", { status: 422 }); }
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repositoryName)}`;
    const result = await this.request({ path, authorization: `Bearer ${accessToken}`, missing: true });
    if (!result) return null;
    const repository = this.repositoryProjection(result.data, owner, repositoryName);
    const reference = await this.request({ path: `${path}/git/ref/heads/${repository.defaultBranch.split("/").map(encodeURIComponent).join("/")}`, authorization: `Bearer ${accessToken}`, missing: true, uninitialized: true });
    if (!reference) return repository;
    const ref = obj(reference.data), gitObject = obj(ref.object);
    if (ref.ref !== `refs/heads/${repository.defaultBranch}` || gitObject.type !== "commit" || typeof gitObject.sha !== "string" || !SHA.test(gitObject.sha)) throw providerError();
    return { ...repository, initialized: true };
  }

  async createRepository(accessToken: string, input: { name: string; description: string; private: boolean }): Promise<CreatedRepository> {
    token(accessToken);
    try {
      name(input.name);
      if (Object.keys(input).some(key => !["name", "description", "private"].includes(key)) || typeof input.description !== "string" || [...input.description].length > 350 || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff\u202a-\u202e\u2066-\u2069]/u.test(input.description) || typeof input.private !== "boolean") throw new Error("input");
    } catch { throw new GitHubHttpError("GITHUB_INVALID_INPUT", "请提供新个人仓库的名称、说明和可见性。", { status: 422 }); }
    const identity = await this.getIdentity(accessToken);
    const response = await this.request({ path: "/user/repos", method: "POST", expected: 201, authorization: `Bearer ${accessToken}`, body: { name: input.name, description: input.description, private: input.private, auto_init: true } });
    let created: CreatedRepository;
    try {
      const owner = obj(obj(response?.data).owner);
      if (owner.type !== "User" || id(owner.id) !== identity.id) throw providerError(true);
      created = this.repositoryProjection(response?.data, identity.login, input.name);
      if (created.private !== input.private) throw providerError(true);
    } catch { throw new GitHubHttpError("GITHUB_OUTCOME_UNKNOWN", "仓库创建请求已发出，但创建结果尚未完整核对。", { outcomeUnknown: true, recoveryAction: "reconcile_repository" }); }
    try {
      const verified = await this.getRepository(accessToken, identity.login, input.name);
      if (!verified || verified.repositoryId !== created.repositoryId || !verified.initialized || verified.private !== input.private) return created;
      return verified;
    } catch { return created; }
  }
}
