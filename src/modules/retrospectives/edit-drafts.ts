import { createHash } from "node:crypto";
import type { Actor, Clock, IdGenerator, ProjectAccessPort } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import { answerKeys } from "./domain.ts";
import type { Answers, FinalFactsLockPort, FinalFactsSnapshot, ProjectStatePort, RetrospectiveContent, Scope, ToolExperience } from "./domain.ts";
import * as v from "./validation.ts";
import { redactExportValue } from "./export-safety.ts";
import { parseSkillUsage } from "./skill-usage.ts";

/** An editing buffer owned by one account. requestedScope is an intention only. */
export interface RetrospectiveEditDraft {
  kind: "retrospective_edit_draft";
  id: string;
  ownerId: string;
  projectId: string;
  documentId: string | null;
  baseDocumentRevision: number;
  visibility: "personal";
  requestedScope: Scope;
  draftContent: RetrospectiveContent;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface EditDraftKey { ownerId: string; projectId: string; documentId: string | null }
export interface EditDraftSaveInput {
  documentId: string | null;
  baseDocumentRevision: number;
  expectedRevision: number;
  mutationId: string;
  requestedScope: Scope;
  draftContent: RetrospectiveContent;
}
export interface EditDraftSaveResult { draft: RetrospectiveEditDraft; acceptedRevision: number; replayed: boolean }
export interface EditDraftFilter { projectId?: string; limit?: number; afterId?: string }
export interface EditDraftPage { items: RetrospectiveEditDraft[]; nextCursor: string | null }
export interface EditDraftMutationReceipt {
  payloadHash: string;
  draftId: string | null;
  acceptedRevision: number | null;
}
export interface EditDraftTransaction {
  readonly sql?: SqlExecutor;
  get(key: EditDraftKey): Promise<RetrospectiveEditDraft | null>;
  getById(id: string, ownerId: string): Promise<RetrospectiveEditDraft | null>;
  /** Claim and lock an account's mutation key before locking its draft root. */
  claimMutation(ownerId: string, mutationId: string, payloadHash: string): Promise<EditDraftMutationReceipt>;
  recordMutation(ownerId: string, mutationId: string, draftId: string, acceptedRevision: number): Promise<void>;
  /** Serialize first creation, update and deletion, including absent draft rows. */
  lockKey(key: EditDraftKey): Promise<void>;
  put(draft: RetrospectiveEditDraft, expectedRevision: number): Promise<void>;
  delete(id: string, ownerId: string, expectedRevision: number): Promise<void>;
}
export interface EditDraftRepository {
  get(key: EditDraftKey): Promise<RetrospectiveEditDraft | null>;
  getById(id: string, ownerId: string): Promise<RetrospectiveEditDraft | null>;
  list(ownerId: string, filter: Required<Pick<EditDraftFilter, "limit">> & Omit<EditDraftFilter, "limit">): Promise<RetrospectiveEditDraft[]>;
  transaction<T>(work: (transaction: EditDraftTransaction) => Promise<T>): Promise<T>;
}
export interface OwnerRetrospectiveIdentity { id: string; projectId: string; ownerId: string; revision: number }
export interface OwnerRetrospectivePort {
  /** Return only a current identity/version of an actor-owned retrospective.
   * With SQL, use the exact supplied executor and lock that identity against
   * modification/deletion until commit. Do not return answers or source facts. */
  readIdentity(input: { actor: Actor; projectId: string; documentId: string }, transaction?: SqlExecutor): Promise<OwnerRetrospectiveIdentity | null>;
}
export interface EditDraftDependencies {
  repository: EditDraftRepository;
  access: ProjectAccessPort;
  projects: ProjectStatePort;
  ownerRetrospectives: OwnerRetrospectivePort;
  finalFactsLock?: FinalFactsLockPort;
  clock: Clock;
  ids: IdGenerator;
}

export const editDraftBodyLimit = 100_000;
function rawText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) v.invalid(`${label}需要文字，且需在4000字以内。`);
  return value;
}
/** Incomplete answers and whitespace are deliberately preserved verbatim. */
export function validateEditDraftContent(value: unknown): RetrospectiveContent {
  const input = v.object(value, ["answers", "evidenceRefs", "tools", "skillUsage"]);
  const answers = v.object(input.answers, answerKeys);
  if (!Array.isArray(input.tools) || input.tools.length > 20) v.invalid("工具经历最多支持20项。");
  const tools: ToolExperience[] = input.tools.map(item => {
    const tool = v.object(item, ["resourceId", "originalUrl", "usedFor", "limitations", "costAtUse", "verifiedAt", "source"]);
    if (tool.source !== "member_record" || (!tool.resourceId && !tool.originalUrl)) v.invalid("工具经历需要资源标识或原始链接，并标记为成员记录。");
    if (tool.originalUrl !== undefined) v.url(tool.originalUrl);
    return {
      ...(tool.resourceId !== undefined ? { resourceId: v.identifier(tool.resourceId) } : {}),
      ...(tool.originalUrl !== undefined ? { originalUrl: tool.originalUrl as string } : {}),
      usedFor: rawText(tool.usedFor, "工具用途"), limitations: rawText(tool.limitations, "工具限制"), costAtUse: rawText(tool.costAtUse, "当时费用"),
      ...(tool.verifiedAt !== undefined ? { verifiedAt: v.instant(tool.verifiedAt) } : {}), source: "member_record" as const,
    };
  });
  const skillUsage = parseSkillUsage(input.skillUsage, { allowIncomplete: true });
  const content: RetrospectiveContent = { answers: Object.fromEntries(answerKeys.map(key => [key, rawText(answers[key], "复盘回答")])) as Answers, evidenceRefs: v.evidenceRefs(input.evidenceRefs), tools, ...(skillUsage === undefined ? {} : { skillUsage }) };
  if (new TextEncoder().encode(JSON.stringify(content)).byteLength > editDraftBodyLimit) throw new DomainError("BODY_TOO_LARGE", "草稿内容过长，请减少文字或引用。", { status: 413 });
  return content;
}
export function editDraftRevision(value: unknown, allowZero = false): number {
  if (!Number.isSafeInteger(value) || (value as number) < (allowZero ? 0 : 1) || (value as number) >= Number.MAX_SAFE_INTEGER) v.invalid("请提供有效的草稿版本。");
  return value as number;
}
export function editDraftDocumentId(value: unknown): string | null { return value === null ? null : v.identifier(value); }
export function validateEditDraftSaveInput(value: unknown): EditDraftSaveInput {
  const input = v.object(value, ["documentId", "baseDocumentRevision", "expectedRevision", "mutationId", "requestedScope", "draftContent"]);
  const documentId = editDraftDocumentId(input.documentId), baseDocumentRevision = editDraftRevision(input.baseDocumentRevision, true);
  if ((documentId === null) !== (baseDocumentRevision === 0)) v.invalid("新建草稿基线应为0；编辑已有复盘需要其当前版本。");
  return { documentId, baseDocumentRevision, expectedRevision: editDraftRevision(input.expectedRevision, true), mutationId: v.identifier(input.mutationId), requestedScope: v.scope(input.requestedScope), draftContent: validateEditDraftContent(input.draftContent) };
}
export function editDraftConflict(latestRevision: number): never {
  throw new DomainError("VERSION_CONFLICT", "草稿已在其他页面更新，请对照最新草稿后再保存；当前输入仍保留。", { status: 409, latestRevision, recoveryAction: "review_latest_edit_draft" });
}
function notFound(): never { throw new DomainError("NOT_FOUND", "草稿不存在或不属于当前账号。", { status: 404 }); }
function own(draft: RetrospectiveEditDraft | null, ownerId: string): RetrospectiveEditDraft {
  if (!draft || draft.ownerId !== ownerId || draft.visibility !== "personal" || draft.kind !== "retrospective_edit_draft") notFound();
  return draft;
}
export class RetrospectiveEditDraftService {
  private readonly dependencies: EditDraftDependencies;
  constructor(dependencies: EditDraftDependencies) { this.dependencies = dependencies; }
  private async writable(actor: Actor, projectId: string, facts?: FinalFactsSnapshot): Promise<void> {
    const matches = facts?.projects.filter(item => item.projectId === projectId);
    if (facts && (matches?.length !== 1 || typeof matches[0].archived !== "boolean")) throw new DomainError("FINAL_FACTS_INVALID", "事务内项目事实缺失或不一致。", { status: 503 });
    const membership = facts ? matches![0].membership : await this.dependencies.access.getMembership(projectId, actor.userId);
    if (membership && (membership.projectId !== projectId || membership.userId !== actor.userId || !["active", "left", "removed"].includes(membership.status) || !["manager", "member"].includes(membership.role))) throw new DomainError("FINAL_FACTS_INVALID", "成员事实归属不一致。", { status: 503 });
    if (!membership || membership.status !== "active") throw new DomainError("FORBIDDEN", "当前账号已没有项目编辑权限。已有本人草稿仍可从个人经验页查看、导出或删除。", { status: 403, recoveryAction: "manage_own_edit_drafts" });
    if (facts ? matches![0].archived : await this.dependencies.projects.isArchived(projectId)) throw new DomainError("PROJECT_ARCHIVED", "项目已归档，已停止自动保存。已有本人草稿仍可从个人经验页查看、导出或删除。", { status: 409, recoveryAction: "manage_own_edit_drafts" });
  }
  async save(actor: Actor, projectId: string, value: unknown): Promise<EditDraftSaveResult> {
    projectId = v.identifier(projectId); v.identifier(actor.userId);
    const input = validateEditDraftSaveInput(value), key = { ownerId: actor.userId, projectId, documentId: input.documentId };
    const payloadHash = createHash("sha256").update(JSON.stringify({ projectId, ...input, mutationId: undefined })).digest("hex");
    await this.writable(actor, projectId);
    return this.dependencies.repository.transaction(async tx => {
      if (tx.sql && !this.dependencies.finalFactsLock) throw new DomainError("FINAL_FACTS_LOCK_REQUIRED", "最终事实锁尚未接入，草稿暂不能保存；当前输入仍保留。", { status: 503 });
      if (this.dependencies.finalFactsLock && !tx.sql) throw new DomainError("FINAL_FACTS_LOCK_UNAVAILABLE", "仓储尚未提供事务执行器。", { status: 503 });
      const facts = tx.sql && this.dependencies.finalFactsLock ? await this.dependencies.finalFactsLock.lock({ actor, operation: "retrospective.update", projectIds: [projectId], evidence: [], resourceIds: [] }, tx.sql) : undefined;
      if (tx.sql && this.dependencies.finalFactsLock && (!facts || !Array.isArray(facts.projects) || !Array.isArray(facts.evidence) || !Array.isArray(facts.reviewedResourceIds))) throw new DomainError("FINAL_FACTS_INVALID", "事务内项目事实无效。", { status: 503 });
      await this.writable(actor, projectId, facts);
      // Identity locks precede mutation/root locks. An already accepted retry is
      // a read of own text, so a subsequent formal edit does not invalidate it.
      const identity = input.documentId !== null ? await this.dependencies.ownerRetrospectives.readIdentity({ actor, projectId, documentId: input.documentId }, tx.sql) : null;
      const receipt = await tx.claimMutation(actor.userId, input.mutationId, payloadHash);
      if (receipt.payloadHash !== payloadHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "本次保存标识已用于不同内容，请核对后使用新的保存标识。", { status: 409, recoveryAction: "use_new_mutation_id" });
      await tx.lockKey(key);
      if (receipt.draftId !== null) {
        const current = await tx.getById(receipt.draftId, actor.userId);
        if (!current) throw new DomainError("DRAFT_DELETED", "此前已保存的本人草稿已删除，重复请求不会恢复它。", { status: 409, recoveryAction: "review_current_edit_draft" });
        if (current.projectId !== projectId || current.documentId !== input.documentId || receipt.acceptedRevision === null) throw new DomainError("FINAL_FACTS_INVALID", "草稿保存回执归属无效。", { status: 503 });
        return { draft: structuredClone(own(current, actor.userId)), acceptedRevision: receipt.acceptedRevision, replayed: true };
      }
      if (input.documentId !== null) {
        if (!identity || identity.id !== input.documentId || identity.ownerId !== actor.userId || identity.projectId !== projectId) notFound();
        if (!Number.isSafeInteger(identity.revision) || identity.revision < 1) throw new DomainError("FINAL_FACTS_INVALID", "复盘身份版本无效。", { status: 503 });
        if (identity.revision !== input.baseDocumentRevision) throw new DomainError("DOCUMENT_CHANGED", "正式复盘已更新，请对照当前复盘与本人编辑草稿后再继续；当前输入仍保留。", { status: 409, recoveryAction: "review_current_retrospective", latestRevision: identity.revision });
      }
      const current = await tx.get(key);
      if (current && (current.ownerId !== actor.userId || current.projectId !== projectId || current.documentId !== input.documentId)) notFound();
      if ((current?.revision ?? 0) !== input.expectedRevision) editDraftConflict(current?.revision ?? 0);
      const now = this.dependencies.clock.now().toISOString();
      const draft: RetrospectiveEditDraft = { kind: "retrospective_edit_draft", id: current?.id ?? v.identifier(this.dependencies.ids.next()), ownerId: actor.userId, projectId, documentId: input.documentId, baseDocumentRevision: input.baseDocumentRevision, visibility: "personal", requestedScope: input.requestedScope, draftContent: structuredClone(input.draftContent), revision: input.expectedRevision + 1, createdAt: current?.createdAt ?? now, updatedAt: now };
      await tx.put(draft, input.expectedRevision);
      await tx.recordMutation(actor.userId, input.mutationId, draft.id, draft.revision);
      return { draft: structuredClone(draft), acceptedRevision: draft.revision, replayed: false };
    });
  }
  /** Reads only stored own text and identifiers; never expands project evidence. */
  async get(actor: Actor, projectId: string, documentId: string | null = null): Promise<RetrospectiveEditDraft | null> {
    const key = { ownerId: v.identifier(actor.userId), projectId: v.identifier(projectId), documentId: editDraftDocumentId(documentId) };
    const draft = await this.dependencies.repository.get(key);
    return draft ? structuredClone(own(draft, actor.userId)) : null;
  }
  async getById(actor: Actor, id: string): Promise<RetrospectiveEditDraft> { return structuredClone(own(await this.dependencies.repository.getById(v.identifier(id), v.identifier(actor.userId)), actor.userId)); }
  async list(actor: Actor, filter: EditDraftFilter = {}): Promise<EditDraftPage> {
    const input = v.object(filter, ["projectId", "limit", "afterId"]), limit = input.limit ?? 30;
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100) v.invalid("每页草稿数量应为1至100。");
    const rows = await this.dependencies.repository.list(v.identifier(actor.userId), { limit: (limit as number) + 1, ...(input.projectId !== undefined ? { projectId: v.identifier(input.projectId) } : {}), ...(input.afterId !== undefined ? { afterId: v.identifier(input.afterId) } : {}) });
    const items = rows.slice(0, limit as number).map(row => structuredClone(own(row, actor.userId)));
    return { items, nextCursor: rows.length > (limit as number) ? items.at(-1)!.id : null };
  }
  /** Private deletion intentionally remains available after leaving/archive. */
  async delete(actor: Actor, id: string, expectedRevision: unknown): Promise<void> {
    const expected = editDraftRevision(expectedRevision), draft = await this.getById(actor, id);
    await this.dependencies.repository.transaction(async tx => {
      await tx.lockKey({ ownerId: actor.userId, projectId: draft.projectId, documentId: draft.documentId });
      const current = own(await tx.getById(draft.id, actor.userId), actor.userId);
      if (current.revision !== expected) editDraftConflict(current.revision);
      await tx.delete(current.id, actor.userId, expected);
    });
  }
  async exportDraft(actor: Actor, id: string, format: "json" | "markdown"): Promise<{ content: string; mediaType: string; filename: string }> {
    if (format !== "json" && format !== "markdown") v.invalid("请选择JSON或Markdown格式。");
    const draft = await this.getById(actor, id), content = validateEditDraftContent(draft.draftContent);
    const clean = redactExportValue(content);
    const payload = redactExportValue({ kind: draft.kind, id: draft.id, projectId: draft.projectId, documentId: draft.documentId, baseDocumentRevision: draft.baseDocumentRevision, revision: draft.revision, visibility: "personal", requestedScope: draft.requestedScope, draftContent: clean, createdAt: draft.createdAt, updatedAt: draft.updatedAt, notice: "本人编辑草稿，尚未正式保存、发布或共享；引用未在导出时读取或核验。" });
    if (format === "json") return { content: JSON.stringify(payload, null, 2), mediaType: "application/json; charset=utf-8", filename: `retrospective-edit-draft-${draft.revision}.json` };
    const safe = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[\\`*_{}\[\]()#!|]/g, "\\$&");
    const labels = ["计划与实际交付", "阻塞与处理", "有帮助的做法", "范围删减", "下次改变"];
    const lines = ["# 本人复盘编辑草稿", "", payload.notice, "", `草稿版本：${draft.revision}；正式复盘基线：${draft.baseDocumentRevision}；分享意图：${draft.requestedScope === "personal" ? "本人" : "项目"}`, ""];
    answerKeys.forEach((key, index) => lines.push(`## ${labels[index]}`, "", safe(clean.answers[key]), ""));
    lines.push("## 工具经历（成员记录）", "", ...clean.tools.map(tool => `- ${safe(tool.usedFor)}；限制：${safe(tool.limitations)}；当时费用：${safe(tool.costAtUse)}；来源：${safe(tool.resourceId ?? tool.originalUrl ?? "未记录")}`), "", "## 未展开的证据引用", "", ...clean.evidenceRefs.map(ref => `- ${safe(ref.kind)} / ${safe(ref.id)} / 版本${ref.revision}`));
    if (clean.skillUsage?.length) {
      lines.push("", "## 技能使用反馈（成员自报，未确认）", "", "历史引用和本人反馈不证明安装或兼容性，复用前重新核验。", "");
      for (const item of clean.skillUsage) lines.push(`- ${safe(item.reference.kind)} / ${safe(item.reference.id)} / ${safe(item.reference.version)} / ${safe(item.reference.versionId)} / ${safe(item.reference.contentHash)} / revision ${item.reference.revision}`, `  用途：${safe(item.purpose)}`, `  本人反馈：${safe(item.feedback)}`, `  限制：${safe(item.limitations)}`);
    }
    return { content: lines.join("\n"), mediaType: "text/markdown; charset=utf-8", filename: `retrospective-edit-draft-${draft.revision}.md` };
  }
}
