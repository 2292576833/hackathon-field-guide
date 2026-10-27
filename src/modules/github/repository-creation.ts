import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { CreatedRepository, GitHubIdentity, RepositoryCreationDependencies, RepositoryCreationOperation } from "./authorization-types.ts";
import type { UserCredential } from "./types.ts";
import { hashInput } from "./manifest.ts";
import { requireProjectAccess } from "./permissions.ts";

const PREVIEW_TTL_MS = 15 * 60 * 1000;
const CREATE_LEASE_MS = 5 * 60 * 1000;
export interface RepositoryCreationInput { name: string; description?: string; private: boolean; idempotencyKey: string }

function invalid(message: string): never { throw new DomainError("INVALID_REPOSITORY_CREATION", message); }
function normalizeInput(input: RepositoryCreationInput): Required<RepositoryCreationInput> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["name", "description", "private", "idempotencyKey"].includes(key))) invalid("新建仓库仅接受名称、说明、可见性和幂等键。");
  if (typeof input.name !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(input.name) || /^\.+$/.test(input.name) || /\.git$/i.test(input.name)) invalid("仓库名称须为 1 至 100 个字母、数字、点、短横线或下划线，不能使用纯点或 .git 后缀。");
  if (typeof input.private !== "boolean") invalid("请明确选择公开或私有仓库。");
  if (typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(input.idempotencyKey)) invalid("请提供有效的幂等键。");
  const description = input.description ?? "";
  if (typeof description !== "string" || [...description].length > 350 || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff\u202a-\u202e\u2066-\u2069]/u.test(description)) invalid("仓库说明须为不超过 350 个字符的普通文本。");
  return { name: input.name, description: description.trim(), private: input.private, idempotencyKey: input.idempotencyKey };
}

/** Stable semantic input, shared by preview idempotency and the persistent store. */
export function repositoryCreationInputHash(operation: Pick<RepositoryCreationOperation, "userId" | "projectId" | "appId" | "githubUserId" | "owner" | "name" | "description" | "private" | "autoInit" | "idempotencyKey">): string {
  return hashInput({ userId: operation.userId, projectId: operation.projectId, appId: operation.appId, githubUserId: operation.githubUserId, owner: operation.owner, name: operation.name, description: operation.description, private: operation.private, autoInit: operation.autoInit, idempotencyKey: operation.idempotencyKey });
}

function creationConfirmationHash(operation: RepositoryCreationOperation): string {
  return hashInput({ operationId: operation.id, userId: operation.userId, projectId: operation.projectId,
    githubUserId: operation.githubUserId, owner: operation.owner, name: operation.name, description: operation.description,
    private: operation.private, autoInit: true, appId: operation.appId, inputHash: repositoryCreationInputHash(operation), expiresAt: operation.expiresAt });
}

function outcomeUnknown(error: unknown): boolean {
  return !(error instanceof DomainError) || (error as DomainError & { outcomeUnknown?: boolean }).outcomeUnknown === true || error.status >= 500 || error.status === 408;
}

export class RepositoryCreationService {
  private readonly d: RepositoryCreationDependencies;
  constructor(dependencies: RepositoryCreationDependencies) {
    if (!Number.isSafeInteger(dependencies.appId) || dependencies.appId < 1) invalid("GitHub 应用配置无效。");
    this.d = dependencies;
  }

  private async assertAccess(actor: Actor, projectId: string): Promise<void> {
    await requireProjectAccess(this.d.access, actor, projectId, true);
    if ((await this.d.capabilities.getCapabilities(projectId, actor.userId)).saveRepository !== true) {
      throw new DomainError("REPOSITORY_CAPABILITY_REQUIRED", "项目尚未允许你创建仓库。", { status: 403 });
    }
  }

  private async identity(actor: Actor): Promise<{ credential: UserCredential; identity: GitHubIdentity }> {
    const credential = await this.d.credentials.getAuthorizationCredential(actor);
    if (credential.websiteUserId !== actor.userId || credential.tokenKind !== "github_app_user" || !Number.isSafeInteger(credential.githubUserId) || credential.githubUserId < 1 || typeof credential.token !== "string" || !credential.token || /\s/.test(credential.token)) {
      throw new DomainError("GITHUB_USER_AUTHORIZATION_REQUIRED", "请连接本人的 GitHub 用户授权。", { status: 403 });
    }
    const identity = await this.d.http.getIdentity(credential.token);
    if (identity.id !== credential.githubUserId || typeof identity.login !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(identity.login)) {
      throw new DomainError("GITHUB_IDENTITY_MISMATCH", "GitHub 当前账号与已保存授权不一致，请重新连接。", { status: 403 });
    }
    return { credential, identity };
  }

  private assertIdentity(operation: RepositoryCreationOperation, identity: GitHubIdentity): void {
    if (operation.appId !== this.d.appId || operation.githubUserId !== identity.id || operation.owner.toLowerCase() !== identity.login.toLowerCase()) {
      throw new DomainError("GITHUB_IDENTITY_CHANGED", "预览时的 GitHub 身份或应用已变化，请新建预览。", { status: 409 });
    }
  }

  private async load(actor: Actor, projectId: string, id: string): Promise<RepositoryCreationOperation> {
    const operation = await this.d.store.get(projectId, actor.userId, id);
    if (!operation || operation.userId !== actor.userId || operation.projectId !== projectId || operation.id !== id) {
      throw new DomainError("REPOSITORY_CREATION_NOT_FOUND", "新建仓库操作不存在或你不能访问。", { status: 404 });
    }
    return operation;
  }

  private async persist(operation: RepositoryCreationOperation, patch: Partial<RepositoryCreationOperation>): Promise<RepositoryCreationOperation> {
    const next = { ...operation, ...patch, revision: operation.revision + 1 };
    await this.d.store.update(next, operation.revision);
    return next;
  }

  private assertRepository(operation: RepositoryCreationOperation, repository: CreatedRepository): void {
    let url: URL;
    try { url = new URL(repository.url); } catch { throw new DomainError("REPOSITORY_CREATION_RESPONSE_MISMATCH", "GitHub 仓库结果无法核对。", { status: 503 }); }
    if (!Number.isSafeInteger(repository.repositoryId) || repository.repositoryId < 1 || repository.owner.toLowerCase() !== operation.owner.toLowerCase() || repository.name.toLowerCase() !== operation.name.toLowerCase() || repository.private !== operation.private || repository.description !== operation.description || url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.search || url.hash || url.pathname.toLowerCase() !== `/${operation.owner}/${operation.name}`.toLowerCase()) {
      throw new DomainError("REPOSITORY_CREATION_RESPONSE_MISMATCH", "GitHub 仓库结果与确认的个人账号、名称或可见性不一致。", { status: 503 });
    }
  }

  async preview(actor: Actor, projectId: string, input: RepositoryCreationInput): Promise<RepositoryCreationOperation> {
    await this.assertAccess(actor, projectId);
    const normalized = normalizeInput(input);
    const { credential, identity } = await this.identity(actor);
    const immutable = { ...normalized, userId: actor.userId, projectId, appId: this.d.appId, githubUserId: identity.id, owner: identity.login, autoInit: true as const };
    const existing = await this.d.store.findByKey(projectId, actor.userId, normalized.idempotencyKey);
    if (existing) {
      if (repositoryCreationInputHash(existing) !== repositoryCreationInputHash(immutable)) throw new DomainError("IDEMPOTENCY_KEY_REUSED", "相同幂等键已经用于不同的新建仓库内容。", { status: 409 });
      return structuredClone(existing);
    }
    if (await this.d.http.getRepository(credential.token, identity.login, normalized.name)) {
      throw new DomainError("REPOSITORY_ALREADY_EXISTS", "该个人账号已存在同名仓库，请选择新名称或显式绑定已有仓库。", { status: 409 });
    }
    const now = this.d.clock.now();
    const operation: RepositoryCreationOperation = { ...immutable, id: this.d.ids.next(), confirmationHash: "", revision: 1, status: "preview",
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + PREVIEW_TTL_MS).toISOString(), repository: null, errorCode: null, leaseUntil: null };
    operation.confirmationHash = creationConfirmationHash(operation);
    return structuredClone(await this.d.store.insert(operation));
  }

  async get(actor: Actor, projectId: string, id: string): Promise<RepositoryCreationOperation> {
    await this.assertAccess(actor, projectId);
    return structuredClone(await this.load(actor, projectId, id));
  }

  async confirm(actor: Actor, projectId: string, id: string, confirmationHash: string): Promise<RepositoryCreationOperation> {
    await this.assertAccess(actor, projectId);
    let operation = await this.load(actor, projectId, id);
    if (typeof confirmationHash !== "string" || confirmationHash !== operation.confirmationHash || operation.confirmationHash !== creationConfirmationHash(operation)) {
      throw new DomainError("REPOSITORY_CREATION_CONFIRMATION_REQUIRED", "请查看仓库名称、个人账号和公开范围后显式确认。", { status: 409 });
    }
    const { credential, identity } = await this.identity(actor);
    this.assertIdentity(operation, identity);
    if (operation.status === "created" || operation.status === "unknown" || operation.status === "creating") return structuredClone(operation);
    if (operation.status !== "preview") throw new DomainError("REPOSITORY_CREATION_RETRY_BLOCKED", "此操作已被阻止，请核对原因后创建新的预览。", { status: 409 });
    if (Date.parse(operation.expiresAt) <= this.d.clock.now().getTime()) throw new DomainError("REPOSITORY_CREATION_PREVIEW_EXPIRED", "新建仓库预览已过期，请重新预览。", { status: 410 });
    if (await this.d.http.getRepository(credential.token, operation.owner, operation.name)) {
      return structuredClone(await this.persist(operation, { status: "blocked", errorCode: "REPOSITORY_ALREADY_EXISTS", leaseUntil: null }));
    }
    // The website permission can be revoked while the repository existence check is pending.
    await this.assertAccess(actor, projectId);
    if (Date.parse(operation.expiresAt) <= this.d.clock.now().getTime()) throw new DomainError("REPOSITORY_CREATION_PREVIEW_EXPIRED", "新建仓库预览已过期，请重新预览。", { status: 410 });
    try {
      operation = await this.persist(operation, { status: "creating", leaseUntil: new Date(this.d.clock.now().getTime() + CREATE_LEASE_MS).toISOString(), errorCode: null });
    } catch (error) {
      if (error instanceof DomainError && error.code === "VERSION_CONFLICT") {
        const latest = await this.load(actor, projectId, id);
        if (latest.status !== "preview") return structuredClone(latest);
      }
      throw error;
    }
    let acknowledgedRepository: CreatedRepository | null = null;
    try {
      // Only this explicitly confirmed creation path issues a POST. The HTTP port always sends auto_init=true.
      const acknowledged = await this.d.http.createRepository(credential.token, { name: operation.name, description: operation.description, private: operation.private });
      this.assertRepository(operation, acknowledged);
      acknowledgedRepository = acknowledged;
      operation = await this.persist(operation, { repository: acknowledged });
      const readback = await this.d.http.getRepository(credential.token, operation.owner, operation.name);
      if (!readback || readback.repositoryId !== acknowledged.repositoryId) throw new DomainError("REPOSITORY_CREATION_READBACK_MISMATCH", "尚不能核对新建仓库的实际 ID。", { status: 503 });
      this.assertRepository(operation, readback);
      if (!readback.initialized || !readback.defaultBranch) throw new DomainError("REPOSITORY_NOT_INITIALIZED", "新建仓库尚未核实初始化完成，请稍后只读核对。", { status: 503 });
      return structuredClone(await this.persist(operation, { repository: readback, status: "created", errorCode: null, leaseUntil: null }));
    } catch (error) {
      const unknown = acknowledgedRepository !== null || operation.repository !== null || outcomeUnknown(error);
      return structuredClone(await this.persist(operation, { status: unknown ? "unknown" : "blocked", repository: acknowledgedRepository ?? operation.repository, errorCode: error instanceof DomainError ? error.code : "REPOSITORY_CREATION_OUTCOME_UNKNOWN", leaseUntil: null }));
    }
  }

  /** Never POSTs, retries creation, binds a repository or infers ownership from a matching name. */
  async reconcile(actor: Actor, projectId: string, id: string): Promise<RepositoryCreationOperation> {
    await this.assertAccess(actor, projectId);
    let operation = await this.load(actor, projectId, id);
    if (operation.status === "created") return structuredClone(operation);
    if (operation.status === "creating" && operation.leaseUntil && Date.parse(operation.leaseUntil) > this.d.clock.now().getTime()) return structuredClone(operation);
    if (operation.status !== "unknown" && operation.status !== "creating") throw new DomainError("REPOSITORY_CREATION_RECONCILIATION_NOT_REQUIRED", "此新建仓库操作无需远端核对。", { status: 409 });
    const { credential, identity } = await this.identity(actor);
    this.assertIdentity(operation, identity);
    try {
      const readback = await this.d.http.getRepository(credential.token, operation.owner, operation.name);
      if (!operation.repository) {
        // The name can have been created by another browser/client. Without an acknowledged ID there is no proof.
        return structuredClone(await this.persist(operation, { status: "unknown", errorCode: readback ? "REPOSITORY_CREATION_UNACKNOWLEDGED_CANDIDATE" : "REPOSITORY_CREATION_OUTCOME_UNKNOWN", leaseUntil: null }));
      }
      if (!readback || readback.repositoryId !== operation.repository.repositoryId) return structuredClone(await this.persist(operation, { status: "unknown", errorCode: "REPOSITORY_CREATION_READBACK_MISMATCH", leaseUntil: null }));
      this.assertRepository(operation, readback);
      if (!readback.initialized || !readback.defaultBranch) return structuredClone(await this.persist(operation, { status: "unknown", errorCode: "REPOSITORY_NOT_INITIALIZED", leaseUntil: null }));
      return structuredClone(await this.persist(operation, { status: "created", repository: readback, errorCode: null, leaseUntil: null }));
    } catch (error) {
      if (error instanceof DomainError && error.code === "VERSION_CONFLICT") throw error;
      operation = await this.persist(operation, { status: "unknown", errorCode: error instanceof DomainError ? error.code : "REPOSITORY_CREATION_READBACK_UNAVAILABLE", leaseUntil: null });
      return structuredClone(operation);
    }
  }
}
