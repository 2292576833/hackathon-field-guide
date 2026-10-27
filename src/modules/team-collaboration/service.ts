import { createHash } from "node:crypto";
import type { Actor, Clock, IdGenerator, ProjectMembershipAccess } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { TeamCollaborationAccessPort, TeamShareSourcePort, TeamTaskActivityPort } from "./ports.ts";
import type { TeamCollaborationRepository, TeamCollaborationTransaction, SuggestionAudit } from "./repository.ts";
import type { EditSuggestionCommand, PublishSuggestionCommand, ShareSourceReference, SuggestionActionCommand, SuggestionReceipt, TeamFeedItem, TeamFeedSnapshot, TeamSuggestion, TeamSuggestionView, VerifiedShareSource } from "./types.ts";

export interface TeamCollaborationDependencies {
  repository: TeamCollaborationRepository; access: TeamCollaborationAccessPort;
  sources: TeamShareSourcePort; activities: TeamTaskActivityPort;
  clock: Clock; ids: IdGenerator;
}
function invalid(message: string): never { throw new DomainError("INVALID_INPUT", message); }
function identifier(value: unknown, label = "记录标识"): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) invalid(`请提供有效的${label}。`);
}
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || Buffer.byteLength(value, "utf8") > max * 4 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) invalid(`${label}不能为空，且不能超过${max}字。`);
  return value.trim();
}
function revision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid("请提供有效的记录版本。");
}
function sourceReference(command: ShareSourceReference): ShareSourceReference {
  if (!["navigator", "space_assistant", "feasibility", "manual"].includes(command.sourceKind)) invalid("分享来源类型无效。");
  if (command.sourceKind === "manual") {
    if (command.sourceId !== null) invalid("成员备注不能附带AI来源标识。");
  } else identifier(command.sourceId, "回答或报告标识");
  return { sourceKind: command.sourceKind, sourceId: command.sourceId };
}
function forbidden(): never { throw new DomainError("PROJECT_ACCESS_DENIED", "当前账号已无法查看或操作这个团队空间。", { status: 403 }); }
function conflict(latestRevision: number): never { throw new DomainError("VERSION_CONFLICT", "队友已更新这条建议。输入已保留，请读取最新版本并核对后再操作。", { status: 409, latestRevision, recoveryAction: "review_latest_version" }); }
function unavailable(): never { throw new DomainError("SHARE_SOURCE_UNAVAILABLE", "回答或报告已失效、撤回或当前不可分享。请重新核对来源。", { status: 409, recoveryAction: "review_source" }); }
function limitValue(value: unknown): number {
  if (value === undefined) return 50;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 100) invalid("读取数量须在1至100之间。");
  return value as number;
}
function receipt(value: TeamSuggestion, replayed = false): SuggestionReceipt { return { id: value.id, revision: value.revision, status: value.status, replayed }; }

/** Suggestions are explicitly shared copies; task state always stays in M05. */
export class TeamCollaborationService {
  private readonly dependencies: TeamCollaborationDependencies;
  constructor(dependencies: TeamCollaborationDependencies) { this.dependencies = dependencies; }

  private async access(actor: Actor, projectId: string, tx: TeamCollaborationTransaction, writable = false, manager = false) {
    const value = await this.dependencies.access.lockAccess(projectId, actor, tx.sql);
    const member = value.membership;
    if (member.projectId !== projectId || member.userId !== actor.userId || member.status !== "active") forbidden();
    if (writable && value.readOnly) throw new DomainError("PROJECT_READ_ONLY", "空间已归档或暂时只读，不能修改团队动态。", { status: 409 });
    if (manager && member.role !== "manager") throw new DomainError("PROJECT_MANAGER_REQUIRED", "只有当前空间管理员可以将建议标记为采纳决定。", { status: 403 });
    return value;
  }

  private async verified(actor: Actor, projectId: string, ownerUserId: string, source: ShareSourceReference, tx: TeamCollaborationTransaction): Promise<VerifiedShareSource | null> {
    const value = await this.dependencies.sources.verifySource({ projectId, actor, ownerUserId, source }, tx.sql);
    if (!value || value.sourceKind !== source.sourceKind || value.sourceId !== source.sourceId || !value.label?.trim() || value.label.length > 120 || !Number.isSafeInteger(value.revision) || value.revision < 1) return null;
    if (source.sourceKind === "manual") return { sourceKind: "manual", sourceId: null, label: "成员备注", revision: value.revision };
    return { sourceKind: value.sourceKind, sourceId: value.sourceId, label: value.label, revision: value.revision };
  }

  private async visible(actor: Actor, projectId: string, value: TeamSuggestion, tx: TeamCollaborationTransaction): Promise<boolean> {
    if (value.status === "withdrawn") return false;
    const current = await this.verified(actor, projectId, value.authorUserId, value.source, tx);
    return Boolean(current && current.revision === value.source.revision);
  }

  private view(value: TeamSuggestion, membership: ProjectMembershipAccess, readOnly: boolean): TeamSuggestionView {
    return { ...structuredClone(value), canEdit: !readOnly && value.authorUserId === membership.userId,
      canWithdraw: !readOnly && value.authorUserId === membership.userId,
      canAdopt: !readOnly && membership.role === "manager" && value.status === "discussion" };
  }

  private readTransaction<T>(projectId: string, work: (tx: TeamCollaborationTransaction) => Promise<T>): Promise<T> {
    const repository = this.dependencies.repository;
    return repository.readTransaction ? repository.readTransaction(projectId, work) : repository.transaction(projectId, work);
  }

  async listFeed(actor: Actor, projectId: string, options: { limit?: number } = {}): Promise<TeamFeedSnapshot> {
    identifier(projectId); const limit = limitValue(options.limit);
    return this.readTransaction(projectId, async tx => {
      const before = await this.access(actor, projectId, tx);
      const suggestions = await tx.list(limit);
      const items: TeamFeedItem[] = [];
      for (const value of suggestions) {
        if (value.projectId !== projectId) continue;
        if (!await this.visible(actor, projectId, value, tx)) {
          items.push({ kind: "unavailable", id: value.id, authorUserId: value.authorUserId, revision: value.revision,
            status: value.status === "withdrawn" ? "withdrawn" : "source_unavailable", occurredAt: value.updatedAt,
            canWithdraw: value.status !== "withdrawn" && !before.readOnly && value.authorUserId === actor.userId });
          continue;
        }
        items.push({ kind: "suggestion", id: value.id, occurredAt: value.updatedAt, suggestion: this.view(value, before.membership, before.readOnly) });
      }
      for (const activity of await this.dependencies.activities.readActivities(projectId, actor, tx.sql, limit)) {
        if (activity.kind !== "task" || !Number.isFinite(Date.parse(activity.occurredAt))) continue;
        // A progress report labelled done without a real check must remain waiting for review.
        items.push({ ...structuredClone(activity), status: activity.status === "done" && !activity.checked ? "review" : activity.status });
      }
      // Root locks sources, and this second check also guards adapters with async availability changes.
      for (let index = 0; index < items.length; index++) {
        const item = items[index]!;
        if (item.kind === "suggestion" && !await this.visible(actor, projectId, item.suggestion, tx)) {
          items[index] = { kind: "unavailable", id: item.id, authorUserId: item.suggestion.authorUserId,
            revision: item.suggestion.revision, status: "source_unavailable", occurredAt: item.occurredAt,
            canWithdraw: !before.readOnly && item.suggestion.authorUserId === actor.userId };
        }
      }
      const after = await this.access(actor, projectId, tx);
      if (after.membership.membershipId !== before.membership.membershipId || after.membership.role !== before.membership.role || after.readOnly !== before.readOnly) forbidden();
      return { projectId, membershipId: after.membership.membershipId, role: after.membership.role, readOnly: after.readOnly,
        checkedAt: this.dependencies.clock.now().toISOString(), items: items.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)).slice(0, limit) };
    });
  }

  /** Bounded effective suggestions only: no withdrawals, private source text or task history. */
  async listSharedContext(actor: Actor, projectId: string, options: { limit?: number } = {}): Promise<TeamSuggestion[]> {
    identifier(projectId); const limit = Math.min(limitValue(options.limit ?? 10), 20);
    return this.readTransaction(projectId, async tx => {
      const before = await this.access(actor, projectId, tx);
      const candidates: TeamSuggestion[] = [];
      for (const value of await tx.list(limit)) if (value.projectId === projectId && await this.visible(actor, projectId, value, tx)) candidates.push(value);
      const result: TeamSuggestion[] = []; let bytes = 0;
      for (const value of candidates) {
        if (!await this.visible(actor, projectId, value, tx)) continue;
        const size = Buffer.byteLength(JSON.stringify(value), "utf8");
        if (bytes + size > 32768) continue;
        result.push(structuredClone(value)); bytes += size;
      }
      const after = await this.access(actor, projectId, tx);
      if (after.membership.membershipId !== before.membership.membershipId || after.readOnly !== before.readOnly || after.membership.role !== before.membership.role) forbidden();
      return result;
    });
  }

  async publish(actor: Actor, projectId: string, command: PublishSuggestionCommand): Promise<SuggestionReceipt> {
    identifier(projectId); identifier(command.idempotencyKey, "操作标识");
    const title = text(command.title, "标题", 120), body = text(command.body, "分享内容", 6000), source = sourceReference(command);
    return this.mutate(actor, projectId, "published", null, command.idempotencyKey, { title, body, source }, async (tx, membership) => {
      const verified = await this.verified(actor, projectId, actor.userId, source, tx);
      if (!verified) unavailable();
      await this.dependencies.sources.validateNewPublication?.({ projectId, actor, source }, tx.sql);
      const now = this.dependencies.clock.now().toISOString();
      return { id: this.dependencies.ids.next(), projectId, authorUserId: actor.userId, authorMembershipId: membership.membershipId,
        title, body, source: verified, status: "discussion", revision: 1, createdAt: now, updatedAt: now,
        adoptedByUserId: null, adoptedAt: null, withdrawnAt: null };
    });
  }

  async edit(actor: Actor, projectId: string, id: string, command: EditSuggestionCommand): Promise<SuggestionReceipt> {
    revision(command.expectedRevision); const title = text(command.title, "标题", 120), body = text(command.body, "分享内容", 6000);
    return this.mutate(actor, projectId, "edited", id, command.idempotencyKey, { expectedRevision: command.expectedRevision, title, body }, async (tx, _membership, value) => {
      this.assertOwn(actor, value!); this.assertRevision(value!, command.expectedRevision);
      if (!await this.visible(actor, projectId, value!, tx)) unavailable();
      // Editing an adopted decision changes its substance and requires a fresh explicit adoption.
      return { ...value!, title, body, status: "discussion", adoptedAt: null, adoptedByUserId: null, revision: value!.revision + 1, updatedAt: this.dependencies.clock.now().toISOString() };
    });
  }

  async withdraw(actor: Actor, projectId: string, id: string, command: SuggestionActionCommand): Promise<SuggestionReceipt> {
    revision(command.expectedRevision);
    return this.mutate(actor, projectId, "withdrawn", id, command.idempotencyKey, { expectedRevision: command.expectedRevision }, async (_tx, _membership, value) => {
      this.assertOwn(actor, value!); this.assertRevision(value!, command.expectedRevision);
      if (value!.status === "withdrawn") throw new DomainError("SUGGESTION_WITHDRAWN", "这条建议已撤回。", { status: 409 });
      const now = this.dependencies.clock.now().toISOString();
      return { ...value!, title: "", body: "", status: "withdrawn", revision: value!.revision + 1, updatedAt: now, withdrawnAt: now };
    });
  }

  async adopt(actor: Actor, projectId: string, id: string, command: SuggestionActionCommand): Promise<SuggestionReceipt> {
    revision(command.expectedRevision);
    return this.mutate(actor, projectId, "adopted", id, command.idempotencyKey, { expectedRevision: command.expectedRevision }, async (tx, _membership, value) => {
      this.assertRevision(value!, command.expectedRevision);
      if (!await this.visible(actor, projectId, value!, tx)) unavailable();
      if (value!.status !== "discussion") throw new DomainError("SUGGESTION_ALREADY_ADOPTED", "这条建议已经采纳。", { status: 409 });
      const now = this.dependencies.clock.now().toISOString();
      return { ...value!, status: "adopted", adoptedByUserId: actor.userId, adoptedAt: now, revision: value!.revision + 1, updatedAt: now };
    });
  }

  private assertOwn(actor: Actor, value: TeamSuggestion) {
    if (value.authorUserId !== actor.userId) throw new DomainError("SUGGESTION_AUTHOR_REQUIRED", "只能编辑或撤回本人分享的建议。", { status: 403 });
  }
  private assertRevision(value: TeamSuggestion, expected: number) { if (value.revision !== expected) conflict(value.revision); }

  private async mutate(actor: Actor, projectId: string, action: SuggestionAudit["action"], id: string | null, key: string, payload: unknown,
    change: (tx: TeamCollaborationTransaction, membership: ProjectMembershipAccess, value: TeamSuggestion | null) => Promise<TeamSuggestion>): Promise<SuggestionReceipt> {
    identifier(projectId); identifier(key, "操作标识"); if (id !== null) identifier(id);
    const scope = `${actor.userId}:${action}:${id ?? "new"}`;
    const fingerprint = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const run = () => this.dependencies.repository.transaction(projectId, async tx => {
      const before = await this.access(actor, projectId, tx, true, action === "adopted");
      const replay = await tx.getReceipt(scope, key, fingerprint);
      if (replay) {
        const current = await tx.get(replay.id);
        if (!current || current.projectId !== projectId) throw new DomainError("NOT_FOUND", "记录不存在。", { status: 404 });
        await this.access(actor, projectId, tx, true, action === "adopted");
        return receipt(current, true);
      }
      const current = id === null ? null : await tx.get(id);
      if (id !== null && (!current || current.projectId !== projectId)) throw new DomainError("NOT_FOUND", "建议不存在或当前不可操作。", { status: 404 });
      const next = await change(tx, before.membership, current);
      // Recheck the verified source after async work before any persisted write. Withdraw remains possible if source is unavailable.
      if (next.status !== "withdrawn" && !await this.visible(actor, projectId, next, tx)) unavailable();
      const after = await this.access(actor, projectId, tx, true, action === "adopted");
      if (after.membership.membershipId !== before.membership.membershipId || after.membership.role !== before.membership.role) forbidden();
      // Still before insert: the suggestion itself must not make its source report stale.
      if (action === "published") await this.dependencies.sources.validateNewPublication?.({ projectId, actor, source: next.source }, tx.sql);
      const audit: SuggestionAudit = { id: this.dependencies.ids.next(), projectId, suggestionId: next.id, actorUserId: actor.userId, action, revision: next.revision, occurredAt: next.updatedAt };
      if (current) await tx.replace(next, current.revision, audit); else await tx.insert(next, audit);
      const result = receipt(next); await tx.putReceipt(scope, key, fingerprint, result);
      return result;
    });
    return this.dependencies.access.withMutationScope
      ? this.dependencies.access.withMutationScope(projectId, actor, run) : run();
  }
}
