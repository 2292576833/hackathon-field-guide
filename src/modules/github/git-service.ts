import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { FileChange, GitOperation, GitServiceDependencies, RepositoryBinding, RepositoryTarget, UserCredential } from "./types.ts";
import { buildPreview, hashInput, validateManifest } from "./manifest.ts";
import { requireProjectAccess } from "./permissions.ts";

const TTL_MS = 24 * 60 * 60 * 1000;
const LEASE_MS = 5 * 60 * 1000;
const fail = (code: string, message: string, recoveryAction = "review_draft") => new DomainError(code, message, { status: 409, recoveryAction });

export class GitService {
  private readonly d: GitServiceDependencies;
  constructor(dependencies: GitServiceDependencies) { this.d = dependencies; }

  private async credential(actor: Actor, target: RepositoryTarget): Promise<UserCredential> {
    const credential = await this.d.credentials.getUserCredential(actor, target);
    if (credential.websiteUserId !== actor.userId || credential.tokenKind !== "github_app_user") {
      throw new DomainError("GITHUB_USER_AUTHORIZATION_REQUIRED", "请连接本人的 GitHub 用户授权。", { status: 403, recoveryAction: "reauthorize_github" });
    }
    const permission = await this.d.github.authorize(credential, target);
    if (permission.githubUserId !== credential.githubUserId || !permission.contentsWrite || !permission.userCanPush) {
      throw new DomainError("GITHUB_WRITE_FORBIDDEN", "你或应用当前没有该仓库的保存权限。", { status: 403, recoveryAction: "reauthorize_github" });
    }
    return credential;
  }

  private async canSave(actor: Actor, projectId: string): Promise<void> {
    await requireProjectAccess(this.d.access, actor, projectId);
    if ((await this.d.capabilities.getCapabilities(projectId, actor.userId)).saveRepository !== true) {
      throw new DomainError("REPOSITORY_CAPABILITY_REQUIRED", "项目尚未允许你保存仓库成果。", { status: 403 });
    }
  }

  async bindRepository(actor: Actor, projectId: string, target: RepositoryTarget, expectedRevision: number | null): Promise<RepositoryBinding> {
    await requireProjectAccess(this.d.access, actor, projectId, true);
    if (!target || typeof target !== "object" || Array.isArray(target) || Object.keys(target).some(key => !["repositoryId", "owner", "name", "installationId", "appId", "defaultBranch"].includes(key)) || !Number.isSafeInteger(target.repositoryId) || target.repositoryId <= 0 || !Number.isSafeInteger(target.installationId) || target.installationId <= 0 || !Number.isSafeInteger(target.appId) || target.appId <= 0 || typeof target.owner !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(target.owner) || typeof target.name !== "string" || !/^[A-Za-z0-9_.-]+$/.test(target.name) || [".", ".."].includes(target.name) || typeof target.defaultBranch !== "string" || !target.defaultBranch || target.defaultBranch.length > 255) {
      throw new DomainError("INVALID_REPOSITORY", "仓库信息不完整。请重新选择授权仓库。");
    }
    const credential = await this.credential(actor, target);
    if (!await this.d.github.getHead(credential, target, target.defaultBranch)) {
      throw new DomainError("REPOSITORY_NOT_INITIALIZED", "请先在 GitHub 初始化仓库，再重新绑定。", { recoveryAction: "initialize_repository" });
    }
    const old = await this.d.store.getBinding(projectId);
    if ((old?.revision ?? null) !== expectedRevision) throw fail("VERSION_CONFLICT", "仓库绑定已更新，请重新查看。");
    await requireProjectAccess(this.d.access, actor, projectId, true);
    const binding: RepositoryBinding = { repositoryId: target.repositoryId, owner: target.owner, name: target.name, installationId: target.installationId, appId: target.appId, defaultBranch: target.defaultBranch, id: old?.id ?? this.d.ids.next(), projectId, boundBy: actor.userId, lastChangedBy: actor.userId, status: "bound", revision: (old?.revision ?? 0) + 1, checkedAt: this.d.clock.now().toISOString() };
    await this.d.store.saveBinding(binding, expectedRevision);
    return binding;
  }

  async unbindRepository(actor: Actor, projectId: string, expectedRevision: number): Promise<void> {
    await requireProjectAccess(this.d.access, actor, projectId, true);
    const binding = await this.d.store.getBinding(projectId);
    if (!binding || binding.revision !== expectedRevision) throw fail("VERSION_CONFLICT", "仓库绑定已更新，请重新查看。");
    await this.d.store.saveBinding({ ...binding, lastChangedBy: actor.userId, status: "revoked", revision: binding.revision + 1, checkedAt: this.d.clock.now().toISOString() }, expectedRevision);
  }

  async getBinding(actor: Actor, projectId: string): Promise<RepositoryBinding | null> {
    await requireProjectAccess(this.d.access, actor, projectId);
    return this.d.store.getBinding(projectId);
  }

  async createDraft(actor: Actor, projectId: string, input: { changes: FileChange[]; idempotencyKey: string; message: string; wantsPullRequest?: boolean }): Promise<GitOperation> {
    await this.canSave(actor, projectId);
    if (!input || !Array.isArray(input.changes) || (input.wantsPullRequest !== undefined && typeof input.wantsPullRequest !== "boolean") || typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(input.idempotencyKey) || typeof input.message !== "string" || !input.message.trim() || input.message.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.message)) throw new DomainError("INVALID_DRAFT", "请提供文件、保存说明和有效的幂等键。");
    const binding = await this.d.store.getBinding(projectId);
    if (!binding || binding.status !== "bound") throw new DomainError("REPOSITORY_NOT_BOUND", "请先绑定项目仓库。", { recoveryAction: "bind_repository" });
    const manifest = validateManifest(input.changes);
    const inputHash = hashInput({ manifest: manifest.inputHash, message: input.message.trim(), wantsPullRequest: input.wantsPullRequest === true, bindingId: binding.id, bindingRevision: binding.revision });
    const existing = await this.d.store.findOperationByKey(projectId, actor.userId, input.idempotencyKey);
    if (existing) {
      if (existing.inputHash !== inputHash) throw fail("IDEMPOTENCY_KEY_REUSED", "相同幂等键已经用于不同内容，请使用新操作。");
      return existing;
    }
    const now = this.d.clock.now();
    const expiresAt = new Date(now.getTime() + TTL_MS).toISOString();
    const draftRef = await this.d.drafts.put({ projectId, actorId: actor.userId, changes: input.changes, expiresAt });
    const id = this.d.ids.next();
    const operation: GitOperation = {
      id, projectId, actorId: actor.userId, bindingId: binding.id, bindingRevision: binding.revision,
      target: { repositoryId: binding.repositoryId, owner: binding.owner, name: binding.name, installationId: binding.installationId, appId: binding.appId, defaultBranch: binding.defaultBranch },
      idempotencyKey: input.idempotencyKey, manifest, inputHash,
      draftRef, expiresAt, message: input.message.trim(), wantsPullRequest: input.wantsPullRequest === true,
      branch: `hackathon/${hashInput(id).slice(0, 32)}`, status: "draft", step: "draft", revision: 1, createdAt: now.toISOString(), updatedAt: now.toISOString(),
      preview: null, treeSha: null, commitSha: null, commitMessage: null, pullRequestUrl: null, pullRequestStatus: input.wantsPullRequest ? "pending" : "not_requested", errorCode: null, leaseUntil: null,
    };
    try {
      const result = await this.d.store.createOperation(operation);
      if (result.draftRef !== draftRef) await this.d.drafts.remove(draftRef);
      return result;
    } catch (error) { await this.d.drafts.remove(draftRef); throw error; }
  }

  private async load(actor: Actor, projectId: string, operationId: string, owner = false): Promise<GitOperation> {
    await requireProjectAccess(this.d.access, actor, projectId);
    const operation = await this.d.store.getOperation(projectId, operationId);
    if (!operation || (owner && operation.actorId !== actor.userId)) throw new DomainError("OPERATION_NOT_FOUND", "保存操作不存在或不可操作。", { status: 404 });
    return operation;
  }
  async getOperation(actor: Actor, projectId: string, operationId: string): Promise<GitOperation> { return this.load(actor, projectId, operationId); }
  /** Owner-only recovery/download; unavailable after TTL and independent of GitHub authorization. */
  async getDraftFiles(actor: Actor, projectId: string, operationId: string): Promise<FileChange[]> {
    return this.changes(await this.load(actor, projectId, operationId, true));
  }
  async listOperations(actor: Actor, projectId: string): Promise<GitOperation[]> { await requireProjectAccess(this.d.access, actor, projectId); return this.d.store.listOperations(projectId); }

  private async persist(operation: GitOperation, patch: Partial<GitOperation>): Promise<GitOperation> {
    const next = { ...operation, ...patch, revision: operation.revision + 1, updatedAt: this.d.clock.now().toISOString() };
    await this.d.store.updateOperation(next, operation.revision);
    return next;
  }
  private async assertBinding(operation: GitOperation): Promise<void> {
    const binding = await this.d.store.getBinding(operation.projectId);
    if (!binding || binding.status !== "bound" || binding.id !== operation.bindingId || binding.revision !== operation.bindingRevision) throw fail("BINDING_CHANGED", "仓库绑定已经更改，请为当前仓库重新建立草稿。");
  }
  private async changes(operation: GitOperation): Promise<FileChange[]> {
    if (Date.parse(operation.expiresAt) <= this.d.clock.now().getTime()) throw new DomainError("DRAFT_EXPIRED", "草稿已过期，请重新选择文件。", { status: 410 });
    const changes = await this.d.drafts.get(operation.draftRef, operation.projectId, operation.actorId);
    if (!changes) throw new DomainError("DRAFT_EXPIRED", "草稿文件已清理，请重新选择文件。", { status: 410 });
    const hash = hashInput({ manifest: validateManifest(changes).inputHash, message: operation.message, wantsPullRequest: operation.wantsPullRequest, bindingId: operation.bindingId, bindingRevision: operation.bindingRevision });
    if (hash !== operation.inputHash) throw fail("DRAFT_CONTENT_CHANGED", "草稿内容已改变，请重新建立并预览。");
    return changes;
  }

  async preview(actor: Actor, projectId: string, operationId: string): Promise<GitOperation> {
    await this.canSave(actor, projectId);
    let operation = await this.load(actor, projectId, operationId, true);
    if (!["draft", "ready_for_preview", "blocked", "failed"].includes(operation.status) || operation.commitSha || operation.treeSha) throw fail("OPERATION_ALREADY_STARTED", "该操作已开始保存，请先核对结果。", "reconcile_operation");
    await this.assertBinding(operation);
    const changes = await this.changes(operation);
    const manifest = validateManifest(changes);
    if (manifest.issues.some(issue => issue.severity === "blocked")) return this.persist(operation, { status: "blocked", errorCode: "MANIFEST_BLOCKED" });
    const credential = await this.credential(actor, operation.target);
    const head = await this.d.github.getHead(credential, operation.target, operation.target.defaultBranch);
    if (!head) throw new DomainError("REPOSITORY_NOT_INITIALIZED", "基分支不存在，请检查仓库初始化状态。");
    const tree = await this.d.github.getTree(credential, operation.target, head.treeSha);
    const beforeByPath: Record<string, string> = Object.create(null);
    for (const change of changes) {
      const found = tree.find(entry => entry.path === change.path.normalize("NFC"));
      if (found?.type === "blob" && ["100644", "100755"].includes(found.mode)) beforeByPath[change.path.normalize("NFC")] = await this.d.github.getBlobText(credential, operation.target, found.sha);
    }
    const filePreview = buildPreview({ manifest, changes, head, tree, beforeByPath, createdAt: this.d.clock.now().toISOString() });
    const preview = { ...filePreview, inputHash: operation.inputHash, previewHash: hashInput({ filePreviewHash: filePreview.previewHash, inputHash: operation.inputHash, target: operation.target, branch: operation.branch, operationId: operation.id }) };
    operation = await this.persist(operation, { preview, status: preview.issues.some(issue => issue.severity === "blocked") ? "blocked" : "ready_for_preview", step: "preview", errorCode: null });
    return operation;
  }

  async confirm(actor: Actor, projectId: string, operationId: string, previewHash: string): Promise<GitOperation> {
    await this.canSave(actor, projectId);
    let operation = await this.load(actor, projectId, operationId, true);
    if (operation.status === "saved" || operation.status === "saving") return operation;
    if (operation.status !== "ready_for_preview" || !operation.preview || operation.preview.previewHash !== previewHash || operation.preview.inputHash !== operation.inputHash || operation.preview.issues.some(issue => issue.severity === "blocked")) throw fail("PREVIEW_CONFIRMATION_REQUIRED", "请查看当前变更后重新确认。", "preview_changes");
    await this.assertBinding(operation);
    const changes = await this.changes(operation);
    let credential = await this.credential(actor, operation.target);
    const head = await this.d.github.getHead(credential, operation.target, operation.target.defaultBranch);
    if (head?.commitSha !== operation.preview.baseHeadSha) return this.persist(operation, { status: "blocked", errorCode: "BASE_HEAD_CHANGED" });
    if (await this.d.github.getHead(credential, operation.target, operation.branch)) return this.persist(operation, { status: "unknown", errorCode: "OPERATION_BRANCH_EXISTS" });
    // CAS claims the operation before any external write; no long database transaction spans GitHub.
    operation = await this.persist(operation, { status: "saving", step: "tree", leaseUntil: new Date(this.d.clock.now().getTime() + LEASE_MS).toISOString(), errorCode: null });
    try {
      if (!operation.treeSha) {
        await this.canSave(actor, projectId);
        await this.assertBinding(operation);
        const normalized = changes.map(change => {
          const path = change.path.normalize("NFC"); const file = operation.preview!.files.find(entry => entry.path === path)!;
          return { ...change, path, mode: change.mode ?? (change.action === "delete" ? file.beforeMode : file.afterMode) ?? "100644" };
        });
        const treeSha = await this.d.github.createTree(credential, operation.target, operation.preview!.baseTreeSha, normalized);
        operation = await this.persist(operation, { treeSha, step: "commit" });
      }
      if (!operation.commitSha) {
        await this.canSave(actor, projectId);
        await this.assertBinding(operation);
        const commitMessage = `${operation.message}\n\nHackathon-Operation: ${operation.id}\nHackathon-Input: ${operation.inputHash}`;
        operation = await this.persist(operation, { commitMessage, step: "commit" });
        const commitSha = await this.d.github.createCommit(credential, operation.target, { treeSha: operation.treeSha!, parentSha: operation.preview!.baseHeadSha, message: commitMessage });
        operation = await this.persist(operation, { commitSha, step: "branch" });
      }
      // Refresh website membership and GitHub permissions immediately before publishing the ref.
      await this.canSave(actor, projectId);
      await this.assertBinding(operation);
      credential = await this.credential(actor, operation.target);
      await this.d.github.createBranch(credential, operation.target, operation.branch, operation.commitSha!);
      operation = await this.persist(operation, { step: "verify" });
      await this.verifyRemote(credential, operation);
      operation = await this.persist(operation, { status: "saved", step: "done", leaseUntil: null });
    } catch (error) {
      const unknown = !(error instanceof DomainError) || (error as DomainError & { outcomeUnknown?: boolean }).outcomeUnknown === true || operation.step === "verify" || (operation.step === "branch" && error instanceof DomainError && [409, 422].includes(error.status));
      return this.persist(operation, { status: unknown ? "unknown" : "blocked", errorCode: error instanceof DomainError ? error.code : "REMOTE_OUTCOME_UNKNOWN", leaseUntil: null });
    }
    return this.tryPullRequest(actor, operation, credential);
  }

  private async verifyRemote(credential: UserCredential, operation: GitOperation): Promise<void> {
    const head = await this.d.github.getHead(credential, operation.target, operation.branch);
    if (!head || head.commitSha !== operation.commitSha) throw fail("REMOTE_BRANCH_MISMATCH", "远端分支尚未匹配本次保存，请核对结果。", "reconcile_operation");
    const commit = await this.d.github.getCommit(credential, operation.target, head.commitSha);
    if (commit.treeSha !== operation.treeSha || commit.parents.length !== 1 || commit.parents[0] !== operation.preview?.baseHeadSha || commit.message !== operation.commitMessage) throw fail("REMOTE_COMMIT_MISMATCH", "远端版本不符合确认的文件与基版本，请人工核对。", "review_remote_version");
  }

  async reconcile(actor: Actor, projectId: string, operationId: string): Promise<GitOperation> {
    await this.canSave(actor, projectId);
    let operation = await this.load(actor, projectId, operationId, true);
    if (operation.status === "saved") return operation;
    if (operation.status === "saving" && operation.leaseUntil && Date.parse(operation.leaseUntil) > this.d.clock.now().getTime()) return operation;
    if (!["unknown", "saving"].includes(operation.status) && !(operation.status === "blocked" && operation.treeSha)) throw fail("RECONCILIATION_NOT_REQUIRED", "该操作无需远端核对。");
    await this.assertBinding(operation);
    const credential = await this.credential(actor, operation.target);
    const head = await this.d.github.getHead(credential, operation.target, operation.branch);
    if (head && operation.commitSha) {
      await this.verifyRemote(credential, operation);
      operation = await this.persist(operation, { status: "saved", step: "done", errorCode: null, leaseUntil: null });
      return operation; // Reconciliation is read-only against GitHub. PR requires its own explicit retry.
    }
    if (head) return this.persist(operation, { status: "unknown", errorCode: "REMOTE_BRANCH_MISMATCH", leaseUntil: null });
    if (operation.commitSha && operation.treeSha && operation.preview) {
      const commit = await this.d.github.getCommit(credential, operation.target, operation.commitSha);
      if (commit.message !== operation.commitMessage || commit.treeSha !== operation.treeSha || commit.parents.length !== 1 || commit.parents[0] !== operation.preview.baseHeadSha) throw fail("REMOTE_COMMIT_MISMATCH", "已有远端版本不符合确认，请人工核对。");
      return this.persist(operation, { status: "ready_for_preview", step: "branch", errorCode: "BRANCH_NOT_CREATED_CONFIRM_TO_RESUME", leaseUntil: null });
    }
    if (operation.status === "blocked" && operation.treeSha && operation.preview) {
      await this.d.github.getTree(credential, operation.target, operation.treeSha);
      return this.persist(operation, { status: "ready_for_preview", step: "commit", errorCode: "COMMIT_NOT_CREATED_CONFIRM_TO_RESUME", leaseUntil: null });
    }
    return this.persist(operation, { status: "unknown", errorCode: "REMOTE_OBJECT_RESULT_UNKNOWN", leaseUntil: null });
  }

  async retryPullRequest(actor: Actor, projectId: string, operationId: string): Promise<GitOperation> {
    await this.canSave(actor, projectId);
    const operation = await this.load(actor, projectId, operationId, true);
    if (operation.status !== "saved" || !operation.wantsPullRequest) throw fail("VERSION_NOT_SAVED", "请先核实版本已保存。");
    await this.assertBinding(operation);
    return this.tryPullRequest(actor, operation, await this.credential(actor, operation.target));
  }

  private async tryPullRequest(actor: Actor, operation: GitOperation, credential: UserCredential): Promise<GitOperation> {
    if (!operation.wantsPullRequest || operation.pullRequestUrl || (operation.step === "pull_request" && operation.leaseUntil && Date.parse(operation.leaseUntil) > this.d.clock.now().getTime())) return operation;
    const priorUncertain = operation.pullRequestStatus === "unknown" || (operation.step === "pull_request" && operation.pullRequestStatus === "pending");
    // Claim PR separately so concurrent retries cannot publish duplicates.
    let current = await this.persist(operation, { step: "pull_request", pullRequestStatus: "pending", leaseUntil: new Date(this.d.clock.now().getTime() + LEASE_MS).toISOString() });
    try {
      await this.canSave(actor, current.projectId);
      await this.assertBinding(current);
      const permission = await this.d.github.authorize(credential, current.target);
      if (!permission.pullRequestsWrite) throw new DomainError("PULL_REQUEST_PERMISSION_REQUIRED", "版本已保存，但应用尚无创建 PR 的权限。", { status: 403 });
      const existing = await this.d.github.findPullRequest(credential, current.target, current.branch, current.target.defaultBranch);
      if (!existing && priorUncertain) return this.persist(current, { pullRequestStatus: "unknown", errorCode: "PULL_REQUEST_RESULT_UNKNOWN", leaseUntil: null });
      await this.assertBinding(current);
      const pullRequestUrl = existing ?? await this.d.github.createPullRequest(credential, current.target, { head: current.branch, base: current.target.defaultBranch, title: Array.from(current.message).slice(0, 128).join(""), body: `参赛项目版本保存。\n\nOperation: ${current.id}\nCommit: ${current.commitSha}\n\n请审核后由有权限者合并。保存版本不代表运行通过或正式提交。` });
      current = await this.persist(current, { pullRequestUrl, pullRequestStatus: "created", step: "done", errorCode: null, leaseUntil: null });
    } catch (error) {
      const unknown = priorUncertain || !(error instanceof DomainError) || (error as DomainError & { outcomeUnknown?: boolean }).outcomeUnknown === true;
      current = await this.persist(current, { pullRequestStatus: unknown ? "unknown" : "failed", errorCode: error instanceof DomainError ? error.code : "PULL_REQUEST_RESULT_UNKNOWN", leaseUntil: null });
    }
    return current;
  }
}

