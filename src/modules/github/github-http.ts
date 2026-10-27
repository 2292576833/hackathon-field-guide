import { Buffer } from "node:buffer";
import { DomainError } from "../../shared/errors.ts";
import type { AuthorizationSnapshot, CommitData, FileChange, GitHead, GitHubPort, GitTreeEntry, RepositoryTarget, UserCredential } from "./types.ts";

// API contract checked 2026-10-08 against official GitHub Docs:
// https://docs.github.com/en/rest/apps/installations?apiVersion=2026-03-10
// https://docs.github.com/en/rest/git/trees?apiVersion=2026-03-10
// https://docs.github.com/en/rest/git/commits?apiVersion=2026-03-10
// https://docs.github.com/en/rest/git/refs?apiVersion=2026-03-10
// https://docs.github.com/en/rest/git/blobs?apiVersion=2026-03-10
// https://docs.github.com/en/rest/pulls/pulls?apiVersion=2026-03-10
// https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api

/** Safe provider metadata only. Never retain the request, token, response body or cause. */
export class GitHubHttpError extends DomainError {
  readonly outcomeUnknown: boolean;
  readonly providerStatus: number | undefined;
  readonly retryAt: string | undefined;

  constructor(code: string, message: string, options: { status?: number; outcomeUnknown?: boolean; providerStatus?: number; retryAt?: string; recoveryAction?: string } = {}) {
    super(code, message, { status: options.status ?? 503, recoveryAction: options.recoveryAction });
    this.name = "GitHubHttpError";
    this.outcomeUnknown = options.outcomeUnknown ?? false;
    this.providerStatus = options.providerStatus;
    this.retryAt = options.retryAt;
  }
}

export interface GitHubHttpAdapterOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxBlobBytes?: number;
  maxResponseBytes?: number;
  maxPages?: number;
  now?: () => number;
}

type JsonObject = Record<string, unknown>;
const API_ORIGIN = "https://api.github.com";
export const GITHUB_API_VERSION = "2026-03-10";
const SHA = /^[a-f0-9]{40}$/i;

function invalidResponse(write = false): GitHubHttpError {
  return new GitHubHttpError(write ? "GITHUB_OUTCOME_UNKNOWN" : "GITHUB_INVALID_RESPONSE", "GitHub 返回的结果无法核对，请重新同步。", { outcomeUnknown: write, recoveryAction: write ? "reconcile_operation" : "sync_github" });
}
function object(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidResponse();
  return value as JsonObject;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw invalidResponse();
  return value;
}
function positiveId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw invalidResponse();
  return value;
}
function sha(value: unknown): string {
  if (typeof value !== "string" || !SHA.test(value)) throw invalidResponse();
  return value;
}
function inputSha(value: string): void {
  if (typeof value !== "string" || !SHA.test(value)) throw new GitHubHttpError("GITHUB_INVALID_INPUT", "仓库版本标识无效。", { status: 422 });
}
function branchName(value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 240 || value === "@" || value.startsWith("-") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".") || value.includes("//") || value.includes("..") || value.includes("@{") || /[\x00-\x20\x7f~^:?*\[\\]/.test(value) || value.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))) {
    throw new GitHubHttpError("GITHUB_INVALID_INPUT", "分支名称无效。", { status: 422 });
  }
}
function filePath(value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 || /[\x00-\x1f\x7f\\]/.test(value) || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.split("/").some((part) => part.length === 0 || part === "." || part === ".." || part.toLowerCase() === ".git") || value.toLowerCase() === ".github" || value.toLowerCase() === ".github/workflows" || value.toLowerCase().startsWith(".github/workflows/")) {
    throw new GitHubHttpError("GITHUB_INVALID_INPUT", "文件路径不在允许的保存范围。", { status: 422 });
  }
}
function denied(code: string, message: string): GitHubHttpError {
  return new GitHubHttpError(code, message, { status: 403, recoveryAction: "reconnect_github" });
}

/** Server-only GitHub App user-token adapter. It never updates or force-updates an existing ref. */
export class GitHubHttpAdapter implements GitHubPort {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly maxBlobBytes: number;
  private readonly maxResponseBytes: number;
  private readonly maxPages: number;
  private readonly now: () => number;

  constructor(options: GitHubHttpAdapterOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxBlobBytes = options.maxBlobBytes ?? 1_048_576;
    this.maxResponseBytes = options.maxResponseBytes ?? 8_388_608;
    this.maxPages = options.maxPages ?? 100;
    this.now = options.now ?? Date.now;
    for (const value of [this.timeoutMs, this.maxBlobBytes, this.maxResponseBytes, this.maxPages]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new GitHubHttpError("GITHUB_INVALID_CONFIG", "GitHub 服务限制配置无效。", { status: 500 });
    }
  }

  private validate(credential: UserCredential, target: RepositoryTarget): void {
    if (!credential || credential.tokenKind !== "github_app_user" || typeof credential.token !== "string" || credential.token.length < 1 || /\s/.test(credential.token) || typeof credential.websiteUserId !== "string" || credential.websiteUserId.length < 1 || !Number.isSafeInteger(credential.githubUserId) || credential.githubUserId <= 0) {
      throw denied("GITHUB_CREDENTIAL_INVALID", "需要重新完成 GitHub 用户授权。");
    }
    if (!target || ![target.repositoryId, target.installationId, target.appId].every((value) => Number.isSafeInteger(value) && value > 0) || typeof target.owner !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(target.owner) || typeof target.name !== "string" || !/^[A-Za-z0-9_.-]+$/.test(target.name) || target.name === "." || target.name === "..") {
      throw new GitHubHttpError("GITHUB_INVALID_INPUT", "仓库绑定信息无效。", { status: 422 });
    }
  }

  private repoPath(target: RepositoryTarget): string {
    return `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}`;
  }

  private classify(response: Response, write: boolean): GitHubHttpError {
    const retryAfter = response.headers.get("retry-after");
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = response.headers.get("x-ratelimit-reset");
    if (response.status === 429 || (response.status === 403 && (retryAfter !== null || remaining === "0"))) {
      let retryTime: number | undefined;
      if (retryAfter !== null && /^\d+$/.test(retryAfter)) retryTime = this.now() + Number(retryAfter) * 1000;
      if (remaining === "0" && reset !== null && /^\d+$/.test(reset)) retryTime = Math.max(retryTime ?? 0, Number(reset) * 1000);
      const retryAt = retryTime !== undefined && Number.isFinite(retryTime) && retryTime <= 8.64e15 ? new Date(retryTime).toISOString() : undefined;
      return new GitHubHttpError("GITHUB_RATE_LIMITED", "GitHub 请求额度暂时用尽，请等待后再继续。", { status: 429, providerStatus: response.status, retryAt, recoveryAction: "wait_then_reconcile" });
    }
    if (response.status >= 500 || response.status === 408) return new GitHubHttpError(write ? "GITHUB_OUTCOME_UNKNOWN" : "GITHUB_SERVICE_UNAVAILABLE", "GitHub 暂时无法确认操作结果。", { outcomeUnknown: write, providerStatus: response.status, recoveryAction: write ? "reconcile_operation" : "sync_github" });
    const errors: Record<number, [string, string, number]> = {
      401: ["GITHUB_CREDENTIAL_EXPIRED", "GitHub 用户授权已失效，请重新连接。", 401],
      403: ["GITHUB_PERMISSION_DENIED", "GitHub 不允许此操作，请检查用户与应用权限及仓库规则。", 403],
      404: ["GITHUB_NOT_FOUND", "GitHub 对象不存在或当前授权无法访问。", 404],
      409: ["GITHUB_CONFLICT", "仓库状态发生变化，请重新核对。", 409],
      422: ["GITHUB_VALIDATION_FAILED", "GitHub 拒绝了此次变更，请核对分支和文件。", 422],
    };
    const [code, message, status] = errors[response.status] ?? ["GITHUB_REQUEST_REJECTED", "GitHub 未接受此次操作。", 503];
    return new GitHubHttpError(code, message, { status, providerStatus: response.status, recoveryAction: "review_github_status" });
  }

  private async readJson(response: Response, signal: AbortSignal, write: boolean): Promise<unknown> {
    const declared = response.headers.get("content-length");
    if (declared !== null && /^\d+$/.test(declared) && Number(declared) > this.maxResponseBytes) {
      await response.body?.cancel();
      throw invalidResponse(write);
    }
    if (response.body === null) throw invalidResponse(write);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > this.maxResponseBytes) {
          await reader.cancel();
          throw invalidResponse(write);
        }
        chunks.push(part.value);
      }
      try {
        const body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
        return JSON.parse(body) as unknown;
      } catch { throw invalidResponse(write); }
    } finally { reader.releaseLock(); }
  }

  private async request(credential: UserCredential, target: RepositoryTarget, path: string, method: "GET" | "POST" = "GET", body?: unknown, allowMissing = false): Promise<{ data: unknown; headers: Headers } | null> {
    this.validate(credential, target);
    const write = method === "POST";
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const task = async (): Promise<{ data: unknown; headers: Headers } | null> => {
      const response = await this.fetcher(`${API_ORIGIN}${path}`, {
        method, redirect: "error", signal: controller.signal, cache: "no-store",
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${credential.token}`, "X-GitHub-Api-Version": GITHUB_API_VERSION, "User-Agent": "hackathon-field-guide", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (response.status === 404 && allowMissing) { await response.body?.cancel(); return null; }
      if (response.status >= 300 || response.status < 200) { await response.body?.cancel(); throw this.classify(response, write); }
      if (response.status !== (write ? 201 : 200)) { await response.body?.cancel(); throw invalidResponse(write); }
      return { data: await this.readJson(response, controller.signal, write), headers: response.headers };
    };
    try {
      return await Promise.race([task(), new Promise<never>((_, reject) => {
        timeout = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, this.timeoutMs);
      })]);
    } catch (error) {
      if (error instanceof GitHubHttpError) throw error;
      throw new GitHubHttpError(write ? "GITHUB_OUTCOME_UNKNOWN" : "GITHUB_SERVICE_UNAVAILABLE", write ? "GitHub 写入结果尚未确认，请先核对上次操作。" : "暂时无法连接 GitHub，请稍后同步。", { outcomeUnknown: write, recoveryAction: write ? "reconcile_operation" : "sync_github" });
    } finally { if (timeout !== undefined) clearTimeout(timeout); }
  }

  private async paged(credential: UserCredential, target: RepositoryTarget, path: string, key: "installations" | "repositories" | null): Promise<unknown[]> {
    const items: unknown[] = [];
    for (let page = 1; page <= this.maxPages; page++) {
      const result = await this.request(credential, target, `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      if (!result) throw invalidResponse();
      const root = key === null ? null : object(result.data);
      const batch = array(root === null ? result.data : root[key!]);
      if (batch.length > 100) throw invalidResponse();
      items.push(...batch);
      const total = root?.total_count;
      if (root !== null && (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0)) throw invalidResponse();
      const next = /(?:^|,)\s*<[^>]+>\s*;\s*rel="next"/.test(result.headers.get("link") ?? "");
      if (!next && batch.length < 100 && (total === undefined || items.length >= (total as number))) return items;
      if (batch.length === 0) throw invalidResponse();
    }
    throw new GitHubHttpError("GITHUB_PAGINATION_LIMIT", "GitHub 授权范围过大，暂时无法完整核对。", { status: 503 });
  }

  async authorize(credential: UserCredential, target: RepositoryTarget): Promise<AuthorizationSnapshot> {
    this.validate(credential, target);
    const userResult = await this.request(credential, target, "/user");
    const githubUserId = positiveId(object(userResult?.data).id);
    if (githubUserId !== credential.githubUserId) throw denied("GITHUB_IDENTITY_MISMATCH", "GitHub 授权账号与当前绑定账号不一致。");
    const installations = await this.paged(credential, target, "/user/installations", "installations");
    const installation = installations.map(object).find((item) => item.id === target.installationId && item.app_id === target.appId);
    if (!installation || installation.suspended_at !== null) throw denied("GITHUB_INSTALLATION_REVOKED", "指定 GitHub 应用安装已撤销、暂停或不可访问。");
    const appPermissions = object(installation.permissions);
    const repositories = await this.paged(credential, target, `/user/installations/${target.installationId}/repositories`, "repositories");
    const allowed = repositories.map(object).find((item) => item.id === target.repositoryId);
    if (!allowed) throw denied("GITHUB_REPOSITORY_NOT_ALLOWED", "此仓库不在当前用户与应用的授权范围。");
    const repositoryResult = await this.request(credential, target, this.repoPath(target));
    const repository = object(repositoryResult?.data);
    if (positiveId(repository.id) !== target.repositoryId) throw denied("GITHUB_REPOSITORY_MISMATCH", "仓库名称指向的仓库已变化，请重新绑定。");
    const userCanPush = object(allowed.permissions).push === true && object(repository.permissions).push === true && repository.archived !== true && repository.disabled !== true;
    return { githubUserId, userCanPush, contentsWrite: userCanPush && appPermissions.contents === "write", pullRequestsWrite: userCanPush && appPermissions.pull_requests === "write" };
  }

  private async ensureWrite(credential: UserCredential, target: RepositoryTarget, permission: "contentsWrite" | "pullRequestsWrite"): Promise<void> {
    const authorization = await this.authorize(credential, target);
    if (!authorization[permission]) throw denied("GITHUB_PERMISSION_DENIED", permission === "contentsWrite" ? "当前用户与应用没有共同的仓库内容写入权限。" : "当前用户与应用没有共同的 PR 创建权限。");
  }

  async getHead(credential: UserCredential, target: RepositoryTarget, branch: string): Promise<GitHead | null> {
    branchName(branch);
    const result = await this.request(credential, target, `${this.repoPath(target)}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`, "GET", undefined, true);
    if (!result) return null;
    const reference = object(result.data);
    const refObject = object(reference.object);
    if (reference.ref !== `refs/heads/${branch}` || refObject.type !== "commit") throw invalidResponse();
    const commitSha = sha(refObject.sha);
    const commit = await this.getCommit(credential, target, commitSha);
    return { commitSha, treeSha: commit.treeSha };
  }

  async getTree(credential: UserCredential, target: RepositoryTarget, treeSha: string): Promise<GitTreeEntry[]> {
    inputSha(treeSha);
    const result = await this.request(credential, target, `${this.repoPath(target)}/git/trees/${treeSha}?recursive=1`);
    const tree = object(result?.data);
    if (sha(tree.sha) !== treeSha || tree.truncated !== false) throw new GitHubHttpError("GITHUB_TREE_INCOMPLETE", "仓库文件列表不完整，无法安全生成变更预览。", { status: 422 });
    return array(tree.tree).map((value): GitTreeEntry => {
      const entry = object(value);
      if (typeof entry.path !== "string" || entry.path.length === 0 || typeof entry.mode !== "string" || !["blob", "tree", "commit"].includes(String(entry.type)) || (entry.size !== undefined && (typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0))) throw invalidResponse();
      return { path: entry.path, mode: entry.mode, type: entry.type as GitTreeEntry["type"], sha: sha(entry.sha), ...(entry.size !== undefined ? { size: entry.size as number } : {}) };
    });
  }

  async getBlobText(credential: UserCredential, target: RepositoryTarget, blobSha: string): Promise<string> {
    inputSha(blobSha);
    const result = await this.request(credential, target, `${this.repoPath(target)}/git/blobs/${blobSha}`);
    const blob = object(result?.data);
    if (sha(blob.sha) !== blobSha || blob.encoding !== "base64" || typeof blob.content !== "string" || typeof blob.size !== "number" || !Number.isSafeInteger(blob.size) || blob.size < 0) throw invalidResponse();
    if (blob.size > this.maxBlobBytes || blob.content.length > Math.ceil(this.maxBlobBytes / 3) * 4 + Math.ceil(this.maxBlobBytes / 45) * 2) throw new GitHubHttpError("GITHUB_BLOB_TOO_LARGE", "远端文件超过文本预览上限。", { status: 422 });
    const encoded = blob.content.replace(/[\r\n]/g, "");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw invalidResponse();
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length !== blob.size || bytes.length > this.maxBlobBytes || bytes.toString("base64") !== encoded) throw invalidResponse();
    try {
      const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      if (content.includes("\0")) throw new Error("binary");
      return content;
    } catch { throw new GitHubHttpError("GITHUB_BLOB_NOT_TEXT", "此远端文件不是支持的 UTF-8 文本。", { status: 422 }); }
  }

  async createTree(credential: UserCredential, target: RepositoryTarget, baseTreeSha: string, changes: FileChange[]): Promise<string> {
    inputSha(baseTreeSha);
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > 1000) throw new GitHubHttpError("GITHUB_INVALID_INPUT", "请选择允许数量的文件变更。", { status: 422 });
    const seen = new Set<string>();
    const entries = changes.map((change) => {
      if (!change || typeof change !== "object") throw new GitHubHttpError("GITHUB_INVALID_INPUT", "文件变更无效。", { status: 422 });
      filePath(change.path);
      const key = change.path.normalize("NFC").toLowerCase();
      if (seen.has(key)) throw new GitHubHttpError("GITHUB_INVALID_INPUT", "存在重复或大小写冲突的文件路径。", { status: 422 });
      seen.add(key);
      const mode = change.mode ?? "100644";
      if (mode !== "100644" && mode !== "100755") throw new GitHubHttpError("GITHUB_INVALID_INPUT", "仅允许保存普通文件。", { status: 422 });
      if (change.action === "delete" && change.content === undefined) return { path: change.path, mode, type: "blob", sha: null };
      if (change.action !== "upsert" || typeof change.content !== "string" || Buffer.byteLength(change.content, "utf8") > this.maxBlobBytes || change.content.includes("\0") || Buffer.from(change.content, "utf8").toString("utf8") !== change.content) throw new GitHubHttpError("GITHUB_INVALID_INPUT", "文件内容不在允许的保存范围。", { status: 422 });
      return { path: change.path, mode, type: "blob", content: change.content };
    });
    for (const path of seen) {
      const components = path.split("/");
      for (let length = 1; length < components.length; length++) {
        if (seen.has(components.slice(0, length).join("/"))) throw new GitHubHttpError("GITHUB_INVALID_INPUT", "文件与目录路径相互冲突，请重新选择。", { status: 422 });
      }
    }
    await this.ensureWrite(credential, target, "contentsWrite");
    const result = await this.request(credential, target, `${this.repoPath(target)}/git/trees`, "POST", { base_tree: baseTreeSha, tree: entries });
    try { return sha(object(result?.data).sha); } catch { throw invalidResponse(true); }
  }

  async createCommit(credential: UserCredential, target: RepositoryTarget, input: { treeSha: string; parentSha: string; message: string }): Promise<string> {
    inputSha(input.treeSha); inputSha(input.parentSha);
    if (typeof input.message !== "string" || input.message.trim().length === 0 || input.message.length > 65_536) throw new GitHubHttpError("GITHUB_INVALID_INPUT", "版本说明无效。", { status: 422 });
    await this.ensureWrite(credential, target, "contentsWrite");
    const result = await this.request(credential, target, `${this.repoPath(target)}/git/commits`, "POST", { message: input.message, tree: input.treeSha, parents: [input.parentSha] });
    try { return sha(object(result?.data).sha); } catch { throw invalidResponse(true); }
  }

  async getCommit(credential: UserCredential, target: RepositoryTarget, commitSha: string): Promise<CommitData> {
    inputSha(commitSha);
    const result = await this.request(credential, target, `${this.repoPath(target)}/git/commits/${commitSha}`);
    const commit = object(result?.data);
    if (sha(commit.sha) !== commitSha || typeof commit.message !== "string") throw invalidResponse();
    return { sha: commitSha, treeSha: sha(object(commit.tree).sha), parents: array(commit.parents).map((parent) => sha(object(parent).sha)), message: commit.message };
  }

  async createBranch(credential: UserCredential, target: RepositoryTarget, branch: string, commitSha: string): Promise<void> {
    branchName(branch); inputSha(commitSha);
    await this.ensureWrite(credential, target, "contentsWrite");
    const result = await this.request(credential, target, `${this.repoPath(target)}/git/refs`, "POST", { ref: `refs/heads/${branch}`, sha: commitSha });
    try {
      const reference = object(result?.data);
      const remote = object(reference.object);
      if (reference.ref !== `refs/heads/${branch}` || remote.type !== "commit" || sha(remote.sha) !== commitSha) throw invalidResponse(true);
    } catch { throw invalidResponse(true); }
  }

  private pullRequestUrl(value: unknown, target: RepositoryTarget): string {
    if (typeof value !== "string") throw invalidResponse();
    let url: URL;
    try { url = new URL(value); } catch { throw invalidResponse(); }
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.port || url.search || url.hash || !new RegExp(`^/${target.owner}/${target.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/pull/[1-9][0-9]*$`, "i").test(url.pathname)) throw invalidResponse();
    return url.href;
  }

  async findPullRequest(credential: UserCredential, target: RepositoryTarget, head: string, base: string): Promise<string | null> {
    branchName(head); branchName(base);
    const query = new URLSearchParams({ state: "all", head: `${target.owner}:${head}`, base });
    const requests = await this.paged(credential, target, `${this.repoPath(target)}/pulls?${query}`, null);
    const matches = requests.map(object).filter((pull) => {
      const remoteHead = object(pull.head); const remoteBase = object(pull.base);
      return remoteHead.ref === head && remoteBase.ref === base && object(remoteHead.repo).id === target.repositoryId && object(remoteBase.repo).id === target.repositoryId;
    });
    if (matches.length > 1) throw new GitHubHttpError("GITHUB_PR_AMBIGUOUS", "同一分支存在多个 PR，需人工核对。", { status: 409 });
    return matches.length === 0 ? null : this.pullRequestUrl(matches[0].html_url, target);
  }

  async createPullRequest(credential: UserCredential, target: RepositoryTarget, input: { head: string; base: string; title: string; body: string }): Promise<string> {
    branchName(input.head); branchName(input.base);
    if (input.head === input.base || typeof input.title !== "string" || input.title.trim().length === 0 || input.title.length > 256 || typeof input.body !== "string" || input.body.length > 65_536) throw new GitHubHttpError("GITHUB_INVALID_INPUT", "PR 内容或目标分支无效。", { status: 422 });
    await this.ensureWrite(credential, target, "pullRequestsWrite");
    const result = await this.request(credential, target, `${this.repoPath(target)}/pulls`, "POST", { head: input.head, base: input.base, title: input.title, body: input.body, maintainer_can_modify: false });
    try { return this.pullRequestUrl(object(result?.data).html_url, target); } catch { throw invalidResponse(true); }
  }
}
