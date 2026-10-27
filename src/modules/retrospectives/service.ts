import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { AuditEvent, DeliverySummary, Dependencies, Document, DocumentTransaction, EvidenceRef, EvidenceState, ExperienceCard, FinalFactsLockRequest, FinalFactsSnapshot, FinalWriteOperation, GenerationJob, Retrospective, ReuseDraft, Scope } from "./domain.ts";
import * as v from "./validation.ts";
import { redactExportValue } from "./export-safety.ts";

export interface DocumentView<T extends Document = Document> {
  id: string;
  revision: number;
  scope: Scope;
  status: T["status"];
  /** Withheld when an evidence source is withdrawn or no longer readable. */
  document: T | null;
  needsReview: boolean;
  evidenceStates: { ref: EvidenceRef; state: EvidenceState["state"] }[];
}
export const reuseRechecks = ["当前赛事资格与材料要求", "截止时间与时区", "成员可用时间、估时和任务依赖", "仓库与第三方账号授权", "工具可用性、费用、账号要求、技术栈、许可与比赛 AI 使用范围", "技能或技能包的精确版本是否仍可获取、目标客户端与环境、许可、学习时间和赛事允许范围；历史使用反馈不是安装或兼容性证明"] as const;
export interface PersonalRecordFilter { projectId?: string; query?: string; status?: string; limit?: number; afterId?: string }
export interface ReuseDraftView {
  draft: ReuseDraft;
  selectedContent: Record<string, unknown> | null;
  requiredRechecks: readonly string[];
  unavailableReason?: string;
}

export class RetrospectiveService {
  private readonly dependencies: Dependencies;
  constructor(dependencies: Dependencies) { this.dependencies = dependencies; }
  private now(): string { return this.dependencies.clock.now().toISOString(); }
  private event(type: AuditEvent["type"], doc: Document, actor: Actor): AuditEvent {
    return { id: this.dependencies.ids.next(), type, aggregateId: doc.id, projectId: doc.projectId, actorId: actor.userId, revision: doc.revision, occurredAt: this.now() };
  }
  private notFound(): never { throw new DomainError("NOT_FOUND", "记录不存在或当前不可查看。", { status: 404 }); }
  private projectFact(facts: FinalFactsSnapshot, projectId: string) {
    const matches = facts.projects.filter(item => item.projectId === projectId);
    if (matches.length !== 1 || typeof matches[0].archived !== "boolean") throw new DomainError("FINAL_FACTS_INVALID", "事务内项目事实缺失或不一致。", { status: 503 });
    return matches[0];
  }
  private async member(actor: Actor, projectId: string, manager = false, facts?: FinalFactsSnapshot): Promise<void> {
    const membership = facts ? this.projectFact(facts, projectId).membership : await this.dependencies.access.getMembership(projectId, actor.userId);
    if (!membership || membership.status !== "active" || membership.userId !== actor.userId || membership.projectId !== projectId || (manager && membership.role !== "manager")) {
      throw new DomainError("FORBIDDEN", manager ? "需要当前项目管理员确认。" : "需要当前项目成员权限。", { status: 403 });
    }
  }
  private async writable(actor: Actor, projectId: string, facts?: FinalFactsSnapshot): Promise<void> {
    await this.member(actor, projectId, false, facts);
    if (facts ? this.projectFact(facts, projectId).archived : await this.dependencies.projects.isArchived(projectId)) throw new DomainError("PROJECT_ARCHIVED", "项目已归档，请恢复项目后再编辑。", { status: 409, recoveryAction: "restore_project" });
  }
  private async readable(actor: Actor, doc: Document, facts?: FinalFactsSnapshot): Promise<void> {
    if (doc.scope === "personal") { if (doc.ownerId !== actor.userId) this.notFound(); }
    else await this.member(actor, doc.projectId, false, facts);
  }
  private async currentReadable(actor: Actor, snapshot: Document): Promise<void> {
    const current = await this.load(snapshot.id);
    if (current.kind !== snapshot.kind || current.projectId !== snapshot.projectId || current.ownerId !== snapshot.ownerId) this.notFound();
    // A historical or cached project scope cannot reopen a withdrawn share.
    await this.readable(actor, current);
    await this.readable(actor, snapshot);
  }
  private async editable(actor: Actor, doc: Document, facts?: FinalFactsSnapshot): Promise<void> {
    await this.readable(actor, doc, facts);
    await this.writable(actor, doc.projectId, facts);
    if (doc.ownerId !== actor.userId) await this.member(actor, doc.projectId, true, facts);
  }
  private expect(doc: Document, expected: unknown): void {
    if (doc.revision !== v.revision(expected)) throw new DomainError("VERSION_CONFLICT", "记录已更新，请对照最新版本后再保存。", { status: 409, recoveryAction: "review_latest_version", latestRevision: doc.revision });
  }
  private async load(id: string, kind?: Document["kind"], tx: DocumentTransaction = this.dependencies.repository): Promise<Document> {
    const doc = await tx.get(v.identifier(id));
    if (!doc || (kind && doc.kind !== kind)) this.notFound();
    return doc;
  }
  private refs(doc: Document): EvidenceRef[] {
    if (doc.kind !== "retrospective" && doc.kind !== "experience_card") return [];
    const refs = [...doc.content.evidenceRefs, ...(doc.kind === "retrospective" ? doc.generatedDraft?.evidenceRefs ?? [] : [])];
    return [...new Map(refs.map(ref => [v.evidenceKey(ref), ref])).values()];
  }
  private async resolve(actor: Actor, projectId: string, refs: EvidenceRef[], audience: Scope, facts?: FinalFactsSnapshot): Promise<EvidenceState[]> {
    if (!refs.length) return [];
    // Owning a private note is not permission to read its former team's sources.
    if (!facts) {
      const membership = await this.dependencies.access.getMembership(projectId, actor.userId);
      if (!membership || membership.status !== "active" || membership.userId !== actor.userId || membership.projectId !== projectId) return refs.map(ref => ({ ref, projectId, state: "unavailable", projectShareable: false }));
    }
    const matches = facts?.evidence.filter(item => item.projectId === projectId && item.audience === audience);
    const result = facts ? (matches?.length === 1 ? matches[0].states : []) : await this.dependencies.evidence.resolve(actor, projectId, refs, audience);
    if (!facts) {
      const membership = await this.dependencies.access.getMembership(projectId, actor.userId);
      if (!membership || membership.status !== "active" || membership.userId !== actor.userId || membership.projectId !== projectId) return refs.map(ref => ({ ref, projectId, state: "unavailable", projectShareable: false }));
    }
    // Normalize from an allowlist. A buggy port cannot add another project's source or private fields.
    return refs.map(ref => {
      const matches = result.filter(item => item.projectId === projectId && v.evidenceKey(item.ref) === v.evidenceKey(ref));
      const item = matches.length === 1 ? matches[0] : undefined;
      if (!item || (audience === "project" && !item.projectShareable) || !["available", "withdrawn", "unavailable", "outdated"].includes(item.state)) return { ref, projectId, state: "unavailable", projectShareable: false };
      return { ref, projectId, state: item.state, projectShareable: item.projectShareable, ...(item.state === "available" && item.title ? { title: v.text(item.title, "证据标题", 500) } : {}) };
    });
  }
  private async validEvidence(actor: Actor, projectId: string, refs: EvidenceRef[], audience: Scope, facts?: FinalFactsSnapshot): Promise<EvidenceState[]> {
    const states = await this.resolve(actor, projectId, refs, audience, facts);
    if (states.some(item => item.state !== "available")) throw new DomainError("EVIDENCE_UNAVAILABLE", "依据已变化或不可共享，请更新引用后再确认。", { status: 409, recoveryAction: "review_evidence" });
    return states;
  }
  private async validResources(ids: readonly string[], facts?: FinalFactsSnapshot): Promise<void> {
    for (const id of ids) if (!(facts ? facts.reviewedResourceIds.includes(id) : await this.dependencies.resources.isReviewed(id))) throw new DomainError("RESOURCE_UNREVIEWED", "资源尚未审核或已下架，请重新选择。", { status: 409, recoveryAction: "review_resources" });
  }
  private resourcesFor(doc: Document): string[] {
    if (doc.kind !== "retrospective" && doc.kind !== "experience_card") return [];
    return [...doc.content.tools.flatMap(tool => tool.resourceId ? [tool.resourceId] : []), ...(doc.kind === "retrospective" ? doc.generatedDraft?.resourceIds ?? [] : [])];
  }
  /** Discover without row locks, then acquire external fact locks before sorted M07
   * rows. Callers must recheck all current/source revisions; never expand the lock
   * set from newly changed documents in this transaction. No model call belongs here. */
  private async finalTransaction<T>(actor: Actor, operation: FinalWriteOperation, candidates: readonly Document[], work: (tx: DocumentTransaction, facts?: FinalFactsSnapshot) => Promise<T>): Promise<T> {
    const documents = [...candidates], documentIds = new Set(candidates.map(doc => doc.id));
    const discovered = new Set<string>();
    for (let index = 0; index < documents.length; index++) {
      const doc = documents[index];
      const sourceId = doc.kind === "experience_card" ? doc.sourceRetrospective?.id : doc.kind === "reuse_draft" ? doc.sourceCardId : undefined;
      if (!sourceId || discovered.has(sourceId)) continue;
      discovered.add(sourceId); documentIds.add(sourceId);
      const source = await this.dependencies.repository.get(sourceId);
      if (source) documents.push(source);
    }
    const evidence = new Map<string, { projectId: string; audience: Scope; refs: Map<string, EvidenceRef> }>();
    for (const doc of documents) {
      if (this.refs(doc).length) {
        const key = JSON.stringify([doc.projectId, doc.scope]);
        const group = evidence.get(key) ?? { projectId: doc.projectId, audience: doc.scope, refs: new Map<string, EvidenceRef>() };
        for (const ref of this.refs(doc)) group.refs.set(v.evidenceKey(ref), ref);
        evidence.set(key, group);
      }
      // A shared card may depend on a personal source that is being explicitly
      // shared/reselected. Lock its references for the card's requested audience too.
      if (doc.kind === "experience_card" && doc.sourceRetrospective) {
        const source = documents.find(item => item.id === doc.sourceRetrospective!.id && item.kind === "retrospective");
        if (source) {
          const sourceKey = JSON.stringify([source.projectId, doc.scope]);
          const sourceGroup = evidence.get(sourceKey) ?? { projectId: source.projectId, audience: doc.scope, refs: new Map<string, EvidenceRef>() };
          for (const ref of this.refs(source)) sourceGroup.refs.set(v.evidenceKey(ref), ref);
          evidence.set(sourceKey, sourceGroup);
        }
      }
    }
    const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
    const request: FinalFactsLockRequest = { actor, operation, projectIds: [...new Set(documents.map(doc => doc.projectId))].sort(), evidence: [...evidence.values()].sort((a, b) => compare(JSON.stringify([a.projectId, a.audience]), JSON.stringify([b.projectId, b.audience]))).map(group => ({ projectId: group.projectId, audience: group.audience, refs: [...group.refs.values()].sort((a, b) => compare(v.evidenceKey(a), v.evidenceKey(b))) })), resourceIds: [...new Set(documents.flatMap(doc => this.resourcesFor(doc)))].sort() };
    return this.dependencies.repository.transaction(async tx => {
      let facts: FinalFactsSnapshot | undefined;
      if (this.dependencies.finalFactsLock) {
        if (!tx.sql) throw new DomainError("FINAL_FACTS_LOCK_UNAVAILABLE", "仓储尚未提供事务执行器，请接入最终事实锁。", { status: 503 });
        facts = await this.dependencies.finalFactsLock.lock(request, tx.sql);
        if (!facts || !Array.isArray(facts.projects) || !Array.isArray(facts.evidence) || !Array.isArray(facts.reviewedResourceIds)) throw new DomainError("FINAL_FACTS_INVALID", "事务内事实快照无效。", { status: 503 });
        for (const projectId of request.projectIds) {
          const fact = this.projectFact(facts, projectId);
          if (fact.membership && (fact.membership.projectId !== projectId || fact.membership.userId !== actor.userId || !["active", "left", "removed"].includes(fact.membership.status) || !["manager", "member"].includes(fact.membership.role))) throw new DomainError("FINAL_FACTS_INVALID", "事务内成员事实归属不一致。", { status: 503 });
        }
      } else if (tx.sql) throw new DomainError("FINAL_FACTS_LOCK_REQUIRED", "最终事实锁尚未接入，暂不能保存；输入仍已保留。", { status: 503 });
      await this.lockDocuments(tx, [...documentIds]);
      return work(tx, facts);
    });
  }
  private async lockDocuments(tx: DocumentTransaction, ids: readonly string[]): Promise<void> {
    for (const id of [...new Set(ids)].sort()) await tx.get(id);
  }
  private async view<T extends Document>(actor: Actor, doc: T): Promise<DocumentView<T>> {
    await this.readable(actor, doc);
    const resourceIds = (doc.kind === "retrospective" || doc.kind === "experience_card") ? [...doc.content.tools.flatMap(tool => tool.resourceId ? [tool.resourceId] : []), ...(doc.kind === "retrospective" ? doc.generatedDraft?.resourceIds ?? [] : [])] : [];
    let resourceChanged = false;
    for (const id of resourceIds) if (!(await this.dependencies.resources.isReviewed(id))) resourceChanged = true;
    let states = await this.resolve(actor, doc.projectId, this.refs(doc), doc.scope);
    if (states.length) {
      const membership = await this.dependencies.access.getMembership(doc.projectId, actor.userId);
      if (!membership || membership.status !== "active" || membership.userId !== actor.userId || membership.projectId !== doc.projectId) states = states.map(item => ({ ...item, state: "unavailable", projectShareable: false }));
    }
    const withheld = states.some(item => item.state === "withdrawn" || item.state === "unavailable");
    await this.currentReadable(actor, doc);
    return { id: doc.id, revision: doc.revision, scope: doc.scope, status: doc.status, document: withheld ? null : doc, needsReview: resourceChanged || states.some(item => item.state !== "available"), evidenceStates: states.map(({ ref, state }) => ({ ref, state })) };
  }
  private async refreshEvidenceView<T extends Document>(actor: Actor, doc: T, view: DocumentView<T>): Promise<DocumentView<T>> {
    const states = await this.resolve(actor, doc.projectId, this.refs(doc), doc.scope);
    await this.currentReadable(actor, doc);
    return { ...view, document: states.some(item => item.state === "withdrawn" || item.state === "unavailable") ? null : view.document, needsReview: view.needsReview || states.some(item => item.state !== "available"), evidenceStates: states.map(({ ref, state }) => ({ ref, state })) };
  }
  async createRetrospective(actor: Actor, projectId: string, input: unknown): Promise<Retrospective> {
    const data = v.object(input, ["scope", "content"]);
    projectId = v.identifier(projectId);
    await this.writable(actor, projectId);
    const content = v.retrospectiveContent(data.content), audience = v.scope(data.scope);
    await this.validEvidence(actor, projectId, content.evidenceRefs, audience);
    await this.validResources(content.tools.flatMap(tool => tool.resourceId ? [tool.resourceId] : []));
    const at = this.now();
    const doc: Retrospective = { kind: "retrospective", id: this.dependencies.ids.next(), projectId, ownerId: actor.userId, scope: audience, revision: 1, status: "draft", content, createdAt: at, updatedAt: at };
    await this.finalTransaction(actor, "retrospective.create", [doc], async (tx, facts) => {
      await this.writable(actor, projectId, facts);
      await this.validEvidence(actor, projectId, content.evidenceRefs, audience, facts);
      await this.validResources(this.resourcesFor(doc), facts);
      await tx.insert(doc, this.event("DocumentEdited", doc, actor));
    });
    return doc;
  }
  async getRetrospective(actor: Actor, id: string): Promise<DocumentView<Retrospective>> {
    return this.view(actor, await this.load(id, "retrospective") as Retrospective);
  }
  async updateRetrospective(actor: Actor, id: string, input: unknown): Promise<DocumentView<Retrospective>> {
    const data = v.object(input, ["expectedRevision", "content", "scope"]);
    const doc = await this.load(id, "retrospective") as Retrospective;
    await this.editable(actor, doc); this.expect(doc, data.expectedRevision);
    const audience = data.scope === undefined ? doc.scope : v.scope(data.scope);
    if (audience !== doc.scope && actor.userId !== doc.ownerId) throw new DomainError("FORBIDDEN", "只有作者可以改变分享范围。", { status: 403 });
    const content = data.content === undefined ? doc.content : v.retrospectiveContent(data.content);
    if (data.content !== undefined || (audience === "project" && doc.scope !== audience)) {
      await this.validEvidence(actor, doc.projectId, content.evidenceRefs, audience);
      await this.validResources(content.tools.flatMap(tool => tool.resourceId ? [tool.resourceId] : []));
    }
    const next: Retrospective = { kind: "retrospective", id: doc.id, projectId: doc.projectId, ownerId: doc.ownerId, createdAt: doc.createdAt, scope: audience, revision: doc.revision + 1, status: "draft", content, updatedAt: this.now() };
    await this.finalTransaction(actor, "retrospective.update", [doc, next], async (tx, facts) => {
      const current = await this.load(doc.id, "retrospective", tx) as Retrospective;
      this.expect(current, doc.revision); await this.editable(actor, current, facts);
      if (data.content !== undefined || (audience === "project" && current.scope !== audience)) {
        await this.validEvidence(actor, current.projectId, content.evidenceRefs, audience, facts);
        await this.validResources(this.resourcesFor(next), facts);
      }
      await tx.replace(next, current.revision, this.event("DocumentEdited", next, actor));
    });
    return this.view(actor, next);
  }
  async confirmRetrospective(actor: Actor, id: string, input: unknown): Promise<Retrospective> {
    const data = v.object(input, ["expectedRevision", "useGeneratedDraft"]);
    if (data.useGeneratedDraft !== undefined && typeof data.useGeneratedDraft !== "boolean") v.invalid("请选择是否采用生成草稿。");
    const doc = await this.load(id, "retrospective") as Retrospective;
    await this.editable(actor, doc); this.expect(doc, data.expectedRevision);
    if (doc.scope === "project") await this.member(actor, doc.projectId, true);
    if (doc.status === "generating" || doc.status === "confirmed") throw new DomainError("INVALID_STATE", "请等待草稿生成结束，或编辑后再确认。", { status: 409 });
    if (data.useGeneratedDraft && !doc.generatedDraft) v.invalid("没有可采用的生成草稿。");
    const generated = data.useGeneratedDraft ? doc.generatedDraft : undefined;
    // Keep every input reference: a model omitting a citation cannot detach derived prose from revoked evidence.
    const content = generated ? { ...doc.content, answers: generated.answers } : doc.content;
    await this.validEvidence(actor, doc.projectId, content.evidenceRefs, doc.scope);
    await this.validResources([...content.tools.flatMap(tool => tool.resourceId ? [tool.resourceId] : []), ...(generated?.resourceIds ?? [])]);
    const next: Retrospective = { ...doc, content, status: "confirmed", revision: doc.revision + 1, confirmedBy: actor.userId, confirmedAt: this.now(), updatedAt: this.now() };
    delete next.activeJobId;
    if (!generated) delete next.generatedDraft;
    await this.finalTransaction(actor, "retrospective.confirm", [doc, next], async (tx, facts) => {
      const current = await this.load(doc.id, "retrospective", tx) as Retrospective;
      this.expect(current, doc.revision); await this.editable(actor, current, facts);
      if (current.scope === "project") await this.member(actor, current.projectId, true, facts);
      await this.validEvidence(actor, current.projectId, content.evidenceRefs, current.scope, facts);
      await this.validResources(this.resourcesFor(next), facts);
      await tx.replace(next, current.revision, this.event("RetrospectiveConfirmed", next, actor));
    });
    return next;
  }
  async createExperienceCard(actor: Actor, projectId: string, input: unknown): Promise<ExperienceCard> {
    const data = v.object(input, ["scope", "content", "sourceRetrospective"]);
    await this.writable(actor, v.identifier(projectId));
    const audience = v.scope(data.scope), content = v.experienceContent(data.content);
    let sourceRetrospective: ExperienceCard["sourceRetrospective"];
    if (data.sourceRetrospective !== undefined) {
      const source = v.object(data.sourceRetrospective, ["id", "revision"]);
      const current = await this.load(v.identifier(source.id), "retrospective") as Retrospective;
      await this.readable(actor, current);
      if (current.projectId !== projectId || current.status !== "confirmed" || current.revision !== v.revision(source.revision)) throw new DomainError("SOURCE_CHANGED", "请选择本项目当前已确认的复盘版本。", { status: 409 });
      if (audience === "project" && current.scope === "personal") throw new DomainError("EXPLICIT_SHARE_REQUIRED", "请先显式分享来源复盘，再创建项目经验卡。", { status: 409 });
      await this.validEvidence(actor, projectId, this.refs(current), audience);
      sourceRetrospective = { id: current.id, revision: current.revision };
    }
    await this.validEvidence(actor, projectId, content.evidenceRefs, audience);
    await this.validResources(content.tools.flatMap(tool => tool.resourceId ? [tool.resourceId] : []));
    const at = this.now();
    const card: ExperienceCard = { kind: "experience_card", id: this.dependencies.ids.next(), projectId, ownerId: actor.userId, scope: audience, revision: 1, status: "draft", content, ...(sourceRetrospective ? { sourceRetrospective } : {}), createdAt: at, updatedAt: at };
    await this.finalTransaction(actor, "experience.create", [card], async (tx, facts) => {
      await this.writable(actor, card.projectId, facts);
      await this.sourceReadable(actor, card, tx, facts);
      await this.validEvidence(actor, card.projectId, content.evidenceRefs, audience, facts);
      await this.validResources(this.resourcesFor(card), facts);
      await tx.insert(card, this.event("DocumentEdited", card, actor));
    });
    return card;
  }
  async getExperienceCard(actor: Actor, id: string): Promise<DocumentView<ExperienceCard>> {
    const card = await this.load(id, "experience_card") as ExperienceCard;
    await this.readable(actor, card);
    if (!(await this.sourceUsable(actor, card))) return { id: card.id, revision: card.revision, scope: card.scope, status: card.status, document: null, needsReview: true, evidenceStates: [] };
    const view = await this.view(actor, card);
    if (!(await this.sourceUsable(actor, card))) return { ...view, document: null, needsReview: true };
    return this.refreshEvidenceView(actor, card, view);
  }
  private async sourceUsable(actor: Actor, card: ExperienceCard, tx: DocumentTransaction = this.dependencies.repository, facts?: FinalFactsSnapshot): Promise<boolean> {
    try { await this.sourceReadable(actor, card, tx, facts); return true; }
    catch (error) {
      if (error instanceof DomainError && ["NOT_FOUND", "FORBIDDEN", "SOURCE_WITHDRAWN", "SOURCE_CHANGED", "EVIDENCE_UNAVAILABLE", "RESOURCE_UNREVIEWED"].includes(error.code)) return false;
      throw error;
    }
  }
  private async sourceReadable(actor: Actor, card: ExperienceCard, tx: DocumentTransaction = this.dependencies.repository, facts?: FinalFactsSnapshot): Promise<void> {
    if (!card.sourceRetrospective) return;
    const source = await this.load(card.sourceRetrospective.id, "retrospective", tx) as Retrospective;
    if (source.projectId !== card.projectId) throw new DomainError("SOURCE_CHANGED", "来源复盘项目不一致。", { status: 409 });
    await this.readable(actor, source, facts);
    if (card.scope === "project" && source.scope === "personal") throw new DomainError("SOURCE_WITHDRAWN", "来源分享已撤回，经验正文暂不可查看。", { status: 409, recoveryAction: "review_evidence" });
    if (source.revision !== card.sourceRetrospective.revision || source.status !== "confirmed") throw new DomainError("SOURCE_CHANGED", "来源复盘已修改，请重新核验经验卡依据。", { status: 409, recoveryAction: "review_evidence" });
    await this.validEvidence(actor, source.projectId, this.refs(source), card.scope, facts);
    await this.validResources(this.resourcesFor(source), facts);
    const latest = await this.load(source.id, "retrospective", tx) as Retrospective;
    if (latest.revision !== card.sourceRetrospective.revision || latest.status !== "confirmed") throw new DomainError("SOURCE_CHANGED", "来源复盘已修改，请重新核验经验卡依据。", { status: 409 });
    if (card.scope === "project" && latest.scope === "personal") throw new DomainError("SOURCE_WITHDRAWN", "来源分享已撤回，经验正文暂不可查看。", { status: 409 });
    await this.readable(actor, source, facts);
    await this.readable(actor, latest, facts);
    if (!facts && this.refs(source).length) await this.member(actor, source.projectId);
    await this.validEvidence(actor, source.projectId, this.refs(source), card.scope, facts);
  }
  async updateExperienceCard(actor: Actor, id: string, input: unknown): Promise<DocumentView<ExperienceCard>> {
    const data = v.object(input, ["expectedRevision", "scope", "content", "status", "sourceRetrospective"]);
    const card = await this.load(id, "experience_card") as ExperienceCard;
    await this.editable(actor, card); this.expect(card, data.expectedRevision);
    const audience = data.scope === undefined ? card.scope : v.scope(data.scope);
    if (audience !== card.scope && actor.userId !== card.ownerId) throw new DomainError("FORBIDDEN", "只有作者可以改变分享范围。", { status: 403 });
    const content = data.content === undefined ? card.content : v.experienceContent(data.content);
    let sourceRetrospective = card.sourceRetrospective;
    if (data.sourceRetrospective !== undefined) {
      if (data.content === undefined && !(await this.sourceUsable(actor, card))) throw new DomainError("SOURCE_WITHDRAWN", "旧依据已变化或撤回，请提供重新撰写的正文后再更换来源。", { status: 409, recoveryAction: "review_evidence" });
      const selected = v.object(data.sourceRetrospective, ["id", "revision"]);
      const source = await this.load(v.identifier(selected.id), "retrospective") as Retrospective;
      await this.readable(actor, source);
      if (source.projectId !== card.projectId || source.status !== "confirmed" || source.revision !== v.revision(selected.revision)) throw new DomainError("SOURCE_CHANGED", "请选择本项目当前已确认的复盘版本。", { status: 409 });
      if (audience === "project" && source.scope === "personal") throw new DomainError("EXPLICIT_SHARE_REQUIRED", "请先显式分享来源复盘。", { status: 409 });
      await this.validEvidence(actor, source.projectId, this.refs(source), audience);
      sourceRetrospective = { id: source.id, revision: source.revision };
    }
    const status = data.status ?? "draft";
    if (status !== "draft" && status !== "outdated" && status !== "archived") v.invalid("请通过确认接口确认经验卡。");
    // Withdrawing sharing or marking a stale card must remain possible after evidence changes.
    if (data.content !== undefined || (audience === "project" && card.scope !== audience)) {
      if (audience === "project") await this.sourceReadable(actor, { ...card, sourceRetrospective, scope: audience });
      await this.validEvidence(actor, card.projectId, content.evidenceRefs, audience);
      await this.validResources(content.tools.flatMap(tool => tool.resourceId ? [tool.resourceId] : []));
    }
    const next: ExperienceCard = { ...card, ...(sourceRetrospective ? { sourceRetrospective } : {}), scope: audience, content, status, revision: card.revision + 1, updatedAt: this.now() };
    delete next.confirmedBy; delete next.confirmedAt;
    await this.finalTransaction(actor, "experience.update", [card, next], async (tx, facts) => {
      const current = await this.load(card.id, "experience_card", tx) as ExperienceCard;
      this.expect(current, card.revision); await this.editable(actor, current, facts);
      if (data.sourceRetrospective !== undefined) {
        if (data.content === undefined && !(await this.sourceUsable(actor, current, tx, facts))) throw new DomainError("SOURCE_WITHDRAWN", "旧依据已变化或撤回，请提供重新撰写的正文后再更换来源。", { status: 409, recoveryAction: "review_evidence" });
        await this.sourceReadable(actor, next, tx, facts);
      }
      if (data.content !== undefined || (audience === "project" && current.scope !== audience)) {
        if (audience === "project") await this.sourceReadable(actor, next, tx, facts);
        await this.validEvidence(actor, current.projectId, content.evidenceRefs, audience, facts);
        await this.validResources(this.resourcesFor(next), facts);
      }
      await tx.replace(next, current.revision, this.event(audience !== current.scope ? "ExperienceCardVisibilityChanged" : "DocumentEdited", next, actor));
    });
    return this.getExperienceCard(actor, next.id);
  }
  async confirmExperienceCard(actor: Actor, id: string, expectedRevision: unknown): Promise<ExperienceCard> {
    const card = await this.load(id, "experience_card") as ExperienceCard;
    await this.editable(actor, card); this.expect(card, expectedRevision);
    if (card.scope === "project") await this.member(actor, card.projectId, true);
    if (card.status === "confirmed" || card.status === "archived") throw new DomainError("INVALID_STATE", "请先编辑这张经验卡。", { status: 409 });
    await this.sourceReadable(actor, card);
    await this.validEvidence(actor, card.projectId, card.content.evidenceRefs, card.scope);
    await this.validResources(card.content.tools.flatMap(tool => tool.resourceId ? [tool.resourceId] : []));
    const next: ExperienceCard = { ...card, status: "confirmed", revision: card.revision + 1, confirmedBy: actor.userId, confirmedAt: this.now(), updatedAt: this.now() };
    await this.finalTransaction(actor, "experience.confirm", [card, next], async (tx, facts) => {
      const current = await this.load(card.id, "experience_card", tx) as ExperienceCard;
      this.expect(current, card.revision); await this.editable(actor, current, facts);
      if (current.scope === "project") await this.member(actor, current.projectId, true, facts);
      await this.sourceReadable(actor, current, tx, facts);
      await this.validEvidence(actor, current.projectId, current.content.evidenceRefs, current.scope, facts);
      await this.validResources(this.resourcesFor(current), facts);
      await tx.replace(next, current.revision, this.event("ExperienceCardConfirmed", next, actor));
    });
    return next;
  }
  async list(actor: Actor, input: { kind: "retrospective" | "experience_card"; projectId?: string; limit?: number; afterId?: string }): Promise<{ items: DocumentView[]; nextCursor: string | null }> {
    if (input.kind !== "retrospective" && input.kind !== "experience_card") v.invalid("列表类型无效。");
    const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) v.invalid("每页数量需为1至100。");
    if (input.projectId) await this.member(actor, v.identifier(input.projectId));
    const documents = await this.dependencies.repository.list({ ...input, ownerId: actor.userId, limit: limit + 1 });
    const page = documents.slice(0, limit), items: DocumentView[] = [];
    for (const doc of page) {
      // Defense in depth if a repository accidentally returns broader results.
      if (doc.kind !== input.kind || (input.projectId && doc.projectId !== input.projectId)) continue;
      if (doc.scope === "personal" && doc.ownerId !== actor.userId) continue;
      if (doc.scope === "project" && !input.projectId) continue;
      try { items.push(doc.kind === "experience_card" ? await this.getExperienceCard(actor, doc.id) : await this.view(actor, doc)); }
      catch (error) { if (!(error instanceof DomainError && ["NOT_FOUND", "FORBIDDEN", "SOURCE_WITHDRAWN", "SOURCE_CHANGED", "EVIDENCE_UNAVAILABLE"].includes(error.code))) throw error; }
    }
    return { items, nextCursor: documents.length > limit ? page.at(-1)?.id ?? null : null };
  }
  async historyVersion(actor: Actor, id: string, revision: unknown): Promise<DocumentView> {
    const current = await this.load(id);
    if (current.kind !== "retrospective" && current.kind !== "experience_card") this.notFound();
    await this.readable(actor, current);
    const previous = await this.dependencies.repository.getVersion(id, v.revision(revision));
    if (!previous || previous.kind !== current.kind || previous.projectId !== current.projectId || previous.ownerId !== current.ownerId) this.notFound();
    if (previous.scope === "personal" && previous.ownerId !== actor.userId) this.notFound();
    if (previous.kind === "experience_card" && !(await this.sourceUsable(actor, previous))) return { id: previous.id, revision: previous.revision, scope: previous.scope, status: previous.status, document: null, needsReview: true, evidenceStates: [] };
    const view = await this.view(actor, previous);
    if (previous.kind === "experience_card" && !(await this.sourceUsable(actor, previous))) return { ...view, document: null, needsReview: true };
    return this.refreshEvidenceView(actor, previous, view);
  }
  /** Owner-only account list; filtering a former project never grants project access. */
  async listPersonalRecords(actor: Actor, kind: "experience_card" | "retrospective", input: PersonalRecordFilter = {}): Promise<{ items: (DocumentView & { projectId: string })[]; nextCursor: string | null }> {
    if (kind !== "experience_card" && kind !== "retrospective") v.invalid("列表类型无效。");
    const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) v.invalid("每页数量需为1至100。");
    const projectId = input.projectId === undefined ? undefined : v.identifier(input.projectId);
    const afterId = input.afterId === undefined ? undefined : v.identifier(input.afterId);
    const query = input.query === undefined ? "" : v.text(input.query, "搜索词", 200).toLocaleLowerCase();
    const statuses = kind === "experience_card" ? ["draft", "confirmed", "outdated", "archived"] : ["draft", "generating", "review_required", "confirmed"];
    if (input.status !== undefined && !statuses.includes(input.status)) v.invalid("筛选状态无效。");
    const items: (DocumentView & { projectId: string })[] = [];
    let scanCursor = afterId, scanned = 0;
    // Scan bounded batches so a filter can find records beyond the first page.
    // Searching happens after authorization; raw hidden prose is never indexed.
    for (;;) {
      const documents = await this.dependencies.repository.list({ ownerId: actor.userId, kind, projectId, afterId: scanCursor, limit: 101, personalOnly: true });
      const page = documents.slice(0, 100);
      for (let index = 0; index < page.length; index++) {
        const doc = page[index]; scanned++; scanCursor = doc.id;
        if (doc.kind !== kind || doc.scope !== "personal" || doc.ownerId !== actor.userId || (projectId && doc.projectId !== projectId) || (input.status && doc.status !== input.status)) continue;
        const view = doc.kind === "experience_card" ? await this.getExperienceCard(actor, doc.id) : await this.getRetrospective(actor, doc.id);
        if (view.scope !== "personal" || (input.status && view.status !== input.status)) continue;
        const searchable = (view.document?.kind === "experience_card" ? [view.document.content.title, view.document.content.scenario, ...view.document.content.advice, view.document.content.conditions, view.document.content.limitations] : view.document?.kind === "retrospective" ? Object.values(view.document.content.answers) : []).concat(view.document && (view.document.kind === "experience_card" || view.document.kind === "retrospective") ? (view.document.content.skillUsage ?? []).flatMap(item => [item.reference.id, item.purpose, item.feedback, item.limitations]) : []).join("\n");
        if (query && !searchable.toLocaleLowerCase().includes(query)) continue;
        items.push({ ...view, projectId: doc.projectId });
        if (items.length === limit) return { items, nextCursor: index < page.length - 1 || documents.length > 100 ? doc.id : null };
      }
      if (documents.length <= 100) return { items, nextCursor: null };
      if (scanned >= 1000) return { items, nextCursor: scanCursor ?? null };
    }
  }
  async listReuseDrafts(actor: Actor, input: Omit<PersonalRecordFilter, "query" | "status"> = {}): Promise<{ items: ReuseDraftView[]; nextCursor: string | null }> {
    const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) v.invalid("每页数量需为1至100。");
    const projectId = input.projectId === undefined ? undefined : v.identifier(input.projectId);
    const afterId = input.afterId === undefined ? undefined : v.identifier(input.afterId);
    const documents = await this.dependencies.repository.list({ ownerId: actor.userId, kind: "reuse_draft", projectId, afterId, limit: limit + 1, personalOnly: true });
    const page = documents.slice(0, limit), items: ReuseDraftView[] = [];
    for (const doc of page) {
      if (doc.kind !== "reuse_draft" || doc.scope !== "personal" || doc.ownerId !== actor.userId || (projectId && doc.projectId !== projectId)) continue;
      items.push(await this.getPersonalReuseDraft(actor, doc.id));
    }
    return { items, nextCursor: documents.length > limit ? page.at(-1)?.id ?? null : null };
  }
  async deletePersonal(actor: Actor, id: string, expectedRevision: unknown): Promise<void> {
    const doc = await this.load(id);
    if (doc.scope !== "personal" || doc.ownerId !== actor.userId || doc.kind === "generation_job") this.notFound();
    this.expect(doc, expectedRevision);
    await this.dependencies.repository.deletePersonal(doc.id, actor.userId, doc.revision, this.event("PersonalDocumentDeleted", doc, actor));
  }
  async createReuseDraft(actor: Actor, targetProjectId: string, input: unknown): Promise<ReuseDraft> {
    const data = v.object(input, ["sourceCardId", "sourceRevision", "selectedFields", "acknowledgeRechecks"]);
    await this.writable(actor, v.identifier(targetProjectId));
    if (data.acknowledgeRechecks !== true) throw new DomainError("RECHECK_REQUIRED", "请确认将在新项目中重新核验规则、日期、容量和工具条件。");
    const card = await this.load(v.identifier(data.sourceCardId), "experience_card") as ExperienceCard;
    await this.readable(actor, card); await this.sourceReadable(actor, card); this.expect(card, data.sourceRevision);
    if (card.projectId === targetProjectId) v.invalid("复用目标需要是另一个项目。");
    if (card.status !== "confirmed") throw new DomainError("CARD_NOT_CONFIRMED", "请先复核并确认经验卡。", { status: 409 });
    const view = await this.view(actor, card);
    if (!view.document || view.needsReview) throw new DomainError("RECHECK_REQUIRED", "经验依据或工具状态已变化，请先复核经验卡。", { status: 409 });
    const selectedFields = v.fields(data.selectedFields), at = this.now();
    if (selectedFields.includes("skillUsage") && !card.content.skillUsage?.length) v.invalid("这张经验卡没有技能使用记录，请选择已有内容。");
    const draft: ReuseDraft = { kind: "reuse_draft", id: this.dependencies.ids.next(), projectId: targetProjectId, ownerId: actor.userId, scope: "personal", revision: 1, status: "draft", sourceCardId: card.id, sourceRevision: card.revision, selectedFields, createdAt: at, updatedAt: at };
    await this.finalTransaction(actor, "experience.reuse", [card, draft], async (tx, facts) => {
      await this.writable(actor, targetProjectId, facts);
      const current = await this.load(card.id, "experience_card", tx) as ExperienceCard;
      this.expect(current, card.revision); await this.readable(actor, current, facts);
      await this.sourceReadable(actor, current, tx, facts);
      if (current.status !== "confirmed") throw new DomainError("CARD_NOT_CONFIRMED", "请先复核并确认经验卡。", { status: 409 });
      await this.validEvidence(actor, current.projectId, current.content.evidenceRefs, current.scope, facts);
      await this.validResources(this.resourcesFor(current), facts);
      await tx.insert(draft, this.event("ExperienceReused", draft, actor));
    });
    return draft;
  }
  async getPersonalReuseDraft(actor: Actor, id: string): Promise<ReuseDraftView> {
    const draft = await this.load(id, "reuse_draft") as ReuseDraft;
    await this.readable(actor, draft);
    try { return await this.getReuseDraft(actor, id); }
    catch (error) {
      if (!(error instanceof DomainError) || !["NOT_FOUND", "FORBIDDEN", "SOURCE_CHANGED", "SOURCE_WITHDRAWN", "RECHECK_REQUIRED", "EVIDENCE_UNAVAILABLE", "RESOURCE_UNREVIEWED"].includes(error.code)) throw error;
      return { draft, selectedContent: null, requiredRechecks: reuseRechecks, unavailableReason: "目标项目权限或来源依据已变化，参考正文暂不可读取。本人仍可查看草案选择和删除草案。" };
    }
  }
  async getReuseDraft(actor: Actor, id: string): Promise<{ draft: ReuseDraft; selectedContent: Record<string, unknown>; requiredRechecks: readonly string[] }> {
    const draft = await this.load(id, "reuse_draft") as ReuseDraft;
    await this.readable(actor, draft); await this.member(actor, draft.projectId);
    const current = await this.load(draft.sourceCardId, "experience_card") as ExperienceCard;
    await this.readable(actor, current); await this.sourceReadable(actor, current);
    if (current.status !== "confirmed" || current.revision !== draft.sourceRevision) throw new DomainError("SOURCE_CHANGED", "来源经验已修改或撤回，请重新选择。", { status: 409 });
    const view = await this.view(actor, current);
    if (!view.document || view.needsReview) throw new DomainError("RECHECK_REQUIRED", "请先复核来源依据与工具条件。", { status: 409 });
    const selectedContent = Object.fromEntries(draft.selectedFields.map(field => [field, structuredClone(current.content[field])]));
    await this.sourceReadable(actor, current);
    await this.validEvidence(actor, current.projectId, this.refs(current), current.scope);
    await this.member(actor, draft.projectId); await this.currentReadable(actor, current);
    return { draft, selectedContent, requiredRechecks: reuseRechecks };
  }
  async exportDocument(actor: Actor, id: string, format: "json" | "markdown"): Promise<{ mediaType: string; filename: string; content: string }> {
    if (format !== "json" && format !== "markdown") v.invalid("仅支持JSON与Markdown导出。");
    const doc = await this.load(id);
    if (doc.kind !== "retrospective" && doc.kind !== "experience_card") this.notFound();
    await this.readable(actor, doc);
    if (doc.kind === "experience_card") await this.sourceReadable(actor, doc);
    let view = await this.view(actor, doc);
    if (doc.kind === "experience_card") await this.sourceReadable(actor, doc);
    view = await this.refreshEvidenceView(actor, doc, view);
    if (!view.document) throw new DomainError("EVIDENCE_UNAVAILABLE", "依据分享已撤回，不能导出受影响正文。", { status: 409 });
    // Export explicit content fields only. No provider payloads, other documents, or account data.
    const content = redactExportValue(doc.kind === "retrospective" ? v.retrospectiveContent(doc.content) : v.experienceContent(doc.content));
    const payload = redactExportValue({ id: doc.id, projectId: doc.projectId, kind: doc.kind, revision: doc.revision, scope: doc.scope, status: doc.status, content, confirmedAt: doc.confirmedAt, needsReview: view.needsReview, evidenceStates: view.evidenceStates });
    if (format === "json") return { mediaType: "application/json; charset=utf-8", filename: `retrospective-${doc.revision}.json`, content: JSON.stringify(payload, null, 2) };
    // Encode HTML and Markdown punctuation in user text so exports cannot introduce active links or raw HTML.
    const safe = (value: string) => redactExportValue(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[\\`*_{}\[\]()#!|]/g, "\\$&");
    const lines = [`# ${doc.kind === "retrospective" ? "参赛复盘" : safe(doc.content.title)}`, "", `版本：${doc.revision} · 范围：${doc.scope === "personal" ? "本人" : "项目"} · 状态：${doc.status}`, "", ...(view.needsReview ? ["依据或工具状态已变化，使用前需要重新核验。", ""] : [])];
    if (doc.kind === "retrospective") {
      const labels = { goalAndOutcome: "计划与实际交付", blockerAndResponse: "阻塞与处理", helpfulPractice: "有帮助的做法", scopeReduction: "范围删减", nextChange: "下次改变" };
      for (const key of Object.keys(labels) as (keyof typeof labels)[]) lines.push(`## ${labels[key]}`, "", safe(doc.content.answers[key]), "");
    }
    else lines.push("## 场景", "", safe(doc.content.scenario), "", "## 建议步骤", "", ...doc.content.advice.map(step => `- ${safe(step)}`), "", "## 适用条件", "", safe(doc.content.conditions), "", "## 不适用或未知", "", safe(doc.content.limitations), "");
    lines.push("## 工具经历（成员记录）", "");
    for (const tool of doc.content.tools) lines.push(`- ${safe(tool.usedFor)}；限制：${safe(tool.limitations)}；当时费用：${safe(tool.costAtUse)}；来源：${safe(tool.resourceId ?? tool.originalUrl ?? "未记录")}；核验时间：${safe(tool.verifiedAt ?? "未记录")}`);
    if (doc.content.skillUsage?.length) {
      lines.push("", "## 技能使用反馈（成员自报）", "", "仅记录历史引用和本人文字，不证明安装成功或兼容性；复用前重新核验精确版本、环境、许可与允许范围。", "");
      for (const item of doc.content.skillUsage) lines.push(`- ${safe(item.reference.kind)} / ${safe(item.reference.id)} / ${safe(item.reference.version)} / 版本标识 ${safe(item.reference.versionId)} / 内容哈希 ${safe(item.reference.contentHash)} / revision ${item.reference.revision}`, `  用途：${safe(item.purpose)}`, `  本人反馈：${safe(item.feedback)}`, `  限制：${safe(item.limitations)}`);
    }
    lines.push("", "## 证据引用", "", ...view.evidenceStates.map(item => `- ${safe(item.ref.kind)} / ${safe(item.ref.id)} / 版本${item.ref.revision} / ${item.state}`));
    return { mediaType: "text/markdown; charset=utf-8", filename: `retrospective-${doc.revision}.md`, content: lines.join("\n") };
  }

  async enqueueGeneration(actor: Actor, id: string, expectedRevision: unknown): Promise<GenerationJob> {
    if (!this.dependencies.model) throw new DomainError("MODEL_UNAVAILABLE", "整理服务尚未接入，可以继续人工填写。", { status: 503, recoveryAction: "edit_manually" });
    if (!this.dependencies.generationBudget) throw new DomainError("MODEL_CONFIG_INVALID", "整理预算限制尚未配置，可以继续人工填写。", { status: 503, recoveryAction: "edit_manually" });
    const doc = await this.load(id, "retrospective") as Retrospective;
    await this.editable(actor, doc); this.expect(doc, expectedRevision);
    if (doc.status === "generating" || doc.status === "confirmed") throw new DomainError("INVALID_STATE", "请先编辑复盘或查看已有任务。", { status: 409 });
    await this.validEvidence(actor, doc.projectId, doc.content.evidenceRefs, doc.scope);
    const at = this.now(), jobId = this.dependencies.ids.next();
    const next: Retrospective = { ...doc, revision: doc.revision + 1, status: "generating", activeJobId: jobId, updatedAt: at };
    const job: GenerationJob = { kind: "generation_job", id: jobId, projectId: doc.projectId, ownerId: actor.userId, scope: doc.scope, revision: 1, retrospectiveId: doc.id, inputRevision: next.revision, status: "queued", attempts: 0, createdAt: at, updatedAt: at };
    await this.finalTransaction(actor, "generation.enqueue", [doc, next, job], async (tx, facts) => {
      const current = await this.load(doc.id, "retrospective", tx) as Retrospective;
      this.expect(current, doc.revision); await this.editable(actor, current, facts);
      await this.validEvidence(actor, current.projectId, current.content.evidenceRefs, current.scope, facts);
      await this.validResources(current.content.tools.flatMap(tool => tool.resourceId ? [tool.resourceId] : []), facts);
      await tx.replace(next, current.revision, this.event("GenerationUpdated", next, actor));
      await tx.insert(job, this.event("GenerationUpdated", job, actor));
    });
    return job;
  }
  async getGenerationJob(actor: Actor, id: string): Promise<GenerationJob> {
    const job = await this.load(id, "generation_job") as GenerationJob;
    const retro = await this.load(job.retrospectiveId, "retrospective") as Retrospective;
    await this.readable(actor, retro);
    // Original private snapshots do not become visible when the source is later shared.
    await this.readable(actor, job);
    return job;
  }
  /** Worker entry point. The coordinator invokes this with a durable job id. */
  async runGeneration(jobId: string): Promise<GenerationJob> {
    let job = await this.load(jobId, "generation_job") as GenerationJob;
    if (job.status !== "queued") return job;
    const actor: Actor = { userId: job.ownerId, platformRoles: [] };
    job = { ...job, status: "running", attempts: 1, revision: job.revision + 1, updatedAt: this.now() };
    // CAS is the worker claim; another worker must not invoke the provider.
    await this.dependencies.repository.replace(job, job.revision - 1, this.event("GenerationUpdated", job, actor));
    let controller: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!this.dependencies.model) throw new DomainError("MODEL_UNAVAILABLE", "整理服务尚未接入。", { status: 503 });
      const doc = await this.load(job.retrospectiveId, "retrospective") as Retrospective;
      await this.editable(actor, doc);
      if (doc.revision !== job.inputRevision || doc.activeJobId !== job.id) throw new DomainError("INPUT_CHANGED", "人工内容已更新，请重新生成。", { status: 409 });
      const states = await this.validEvidence(actor, doc.projectId, doc.content.evidenceRefs, doc.scope);
      const resourceIds = doc.content.tools.flatMap(tool => tool.resourceId ? [tool.resourceId] : []);
      await this.validResources(resourceIds);
      if (!this.dependencies.generationBudget) throw new DomainError("MODEL_CONFIG_INVALID", "整理预算限制尚未配置。", { status: 503 });
      await this.dependencies.generationBudget.reserve({ jobId: job.id, projectId: job.projectId, actorId: actor.userId, occurredAt: this.now() });
      controller = new AbortController();
      const timeout = this.dependencies.modelTimeoutMs ?? 20_000;
      if (!Number.isFinite(timeout) || timeout < 1 || timeout > 60_000) throw new DomainError("MODEL_CONFIG_INVALID", "整理服务超时配置无效。", { status: 503 });
      const output = await Promise.race([
        this.dependencies.model.generate({ retrospectiveId: doc.id, inputRevision: doc.revision, scope: doc.scope, answers: structuredClone(doc.content.answers), evidence: states, tools: structuredClone(doc.content.tools), reviewedResourceIds: resourceIds, promptVersion: "m07-v1" }, controller.signal),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller?.abort(); reject(new DomainError("MODEL_TIMEOUT", "整理超时，请继续人工填写。", { status: 503 })); }, timeout); }),
      ]);
      const draft = v.generatedDraft(output, doc.content.evidenceRefs, resourceIds);
      // Recheck current authorization, evidence, and reviewed resources after the external call.
      await this.editable(actor, doc);
      await this.validEvidence(actor, doc.projectId, this.refs(doc), doc.scope);
      await this.validResources([...resourceIds, ...draft.resourceIds]);
      const next: Retrospective = { ...doc, generatedDraft: draft, status: "review_required", revision: doc.revision + 1, updatedAt: this.now() };
      delete next.activeJobId;
      const finished: GenerationJob = { ...job, status: "succeeded", revision: job.revision + 1, updatedAt: this.now(), finishedAt: this.now() };
      await this.finalTransaction(actor, "generation.complete", [doc, next, job, finished], async (tx, facts) => {
        const current = await this.load(doc.id, "retrospective", tx) as Retrospective;
        this.expect(current, doc.revision); await this.editable(actor, current, facts);
        const currentJob = await this.load(job.id, "generation_job", tx) as GenerationJob;
        this.expect(currentJob, job.revision);
        if (current.activeJobId !== job.id || currentJob.status !== "running") throw new DomainError("INPUT_CHANGED", "整理任务或人工输入已变化。", { status: 409 });
        await this.validEvidence(actor, current.projectId, this.refs(current), current.scope, facts);
        await this.validResources([...resourceIds, ...draft.resourceIds], facts);
        await tx.replace(next, current.revision, this.event("GenerationUpdated", next, actor));
        await tx.replace(finished, currentJob.revision, this.event("GenerationUpdated", finished, actor));
      });
      return finished;
    } catch (error) {
      const failed: GenerationJob = { ...job, status: "failed", revision: job.revision + 1, errorCode: error instanceof DomainError && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : "MODEL_FAILED", updatedAt: this.now(), finishedAt: this.now() };
      await this.dependencies.repository.transaction(async tx => {
        // Cleanup never acquires external fact locks after these sorted document locks.
        await this.lockDocuments(tx, [job.retrospectiveId, job.id]);
        const current = await tx.get(job.retrospectiveId);
        if (current?.kind === "retrospective" && current.activeJobId === job.id && current.revision === job.inputRevision) {
          const restored: Retrospective = { ...current, status: "draft", revision: current.revision + 1, updatedAt: this.now() };
          delete restored.activeJobId;
          await tx.replace(restored, current.revision, this.event("GenerationUpdated", restored, actor));
        }
        await tx.replace(failed, job.revision, this.event("GenerationUpdated", failed, actor));
      });
      return failed;
    } finally { if (timer) clearTimeout(timer); controller?.abort(); }
  }

  /** A worker crash leaves a durable running job. A queue supervisor can expire it;
   * no provider retry occurs, and a late result cannot pass the job revision CAS. */
  async recoverExpiredGeneration(jobId: string): Promise<GenerationJob> {
    const job = await this.load(jobId, "generation_job") as GenerationJob;
    const timeout = this.dependencies.modelTimeoutMs ?? 20_000;
    if (job.status !== "running" || this.dependencies.clock.now().getTime() - Date.parse(job.updatedAt) <= timeout + 30_000) return job;
    const actor: Actor = { userId: job.ownerId, platformRoles: [] };
    const failed: GenerationJob = { ...job, status: "failed", errorCode: "WORKER_EXPIRED", revision: job.revision + 1, finishedAt: this.now(), updatedAt: this.now() };
    await this.dependencies.repository.transaction(async tx => {
      await this.lockDocuments(tx, [job.retrospectiveId, job.id]);
      const retro = await tx.get(job.retrospectiveId);
      if (retro?.kind === "retrospective" && retro.activeJobId === job.id && retro.revision === job.inputRevision) {
        const restored: Retrospective = { ...retro, status: "draft", revision: retro.revision + 1, updatedAt: this.now() };
        delete restored.activeJobId;
        await tx.replace(restored, retro.revision, this.event("GenerationUpdated", restored, actor));
      }
      await tx.replace(failed, job.revision, this.event("GenerationUpdated", failed, actor));
    });
    return failed;
  }

  async deliverySummary(actor: Actor, projectId: string): Promise<DeliverySummary> {
    await this.member(actor, v.identifier(projectId));
    if (!this.dependencies.delivery) throw new DomainError("DELIVERY_UNAVAILABLE", "交付事实服务尚未接入。", { status: 503 });
    const facts = await this.dependencies.delivery.read(actor, projectId);
    if ([...facts.saves, ...facts.verifications, ...facts.submissions].some(item => item.projectId !== projectId)) throw new DomainError("DELIVERY_INVALID", "交付记录项目不匹配。", { status: 503 });
    if (facts.submissions.some(item => (item.status === "verified" && item.verificationSource !== "platform_verified") || (item.status === "reported" && item.verificationSource !== "user_reported") || (item.status === "not_submitted" && item.submittedAt) || (["reported", "verified"].includes(item.status) && !item.submittedAt))) throw new DomainError("DELIVERY_INVALID", "提交记录来源与状态不一致。", { status: 503 });
    const saves = facts.saves.map(item => ({ id: item.id, projectId: item.projectId, revision: item.revision, status: item.status, repositoryUrl: item.repositoryUrl, branch: item.branch, commitSha: item.commitSha, recordedAt: item.recordedAt }));
    const verifications = facts.verifications.map(item => ({ id: item.id, projectId: item.projectId, version: item.version, outcome: item.outcome, verificationSource: item.verificationSource, verifiedAt: item.verifiedAt, environmentSummary: item.environmentSummary, steps: item.steps, blockers: item.blockers, evidenceRefs: item.evidenceRefs, repositoryCommitSha: item.repositoryCommitSha, verifierId: item.verifierId }));
    const submissions: DeliverySummary["submission"]["records"] = facts.submissions.map(item => ({ id: item.id, projectId: item.projectId, version: item.version, eventId: item.eventId, stageId: item.stageId, requirementsVersion: item.requirementsVersion, status: item.status, verificationSource: item.verificationSource, submittedAt: item.submittedAt, platformUrl: item.platformUrl, evidenceRefs: item.evidenceRefs, repositoryCommitSha: item.repositoryCommitSha, recordedAt: item.recordedAt, recordedBy: item.recordedBy, sourceLabel: item.verificationSource === "user_reported" ? "队员记录" : "平台核验" }));
    return { repository: { label: saves.length ? "仓库保存记录" : "未记录", records: saves }, execution: { label: verifications.length ? "运行验收记录" : "未记录", records: verifications }, submission: { label: submissions.length ? "赛事提交记录" : "未记录", records: submissions }, materials: facts.materials.map(item => ({ id: item.id, label: item.label, status: item.status })) };
  }
}
