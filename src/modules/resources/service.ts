import type { Actor, Clock, IdGenerator, PageResult, ProjectAccessPort } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import { createResourceRepositoryInTransaction } from "./postgres.ts";
import { isReviewedResource, normalizeResourceInput, normalizeResourceQuery, resourceInstant, resourceText, resourceUrl, RESOURCE_CATEGORIES, RESOURCE_STAGES, RESOURCE_STACKS, RESOURCE_USES, RESOURCE_PREREQUISITES, RESOURCE_COST_TYPES } from "./domain.ts";
import type { Resource, ResourceBookmark, ResourceBookmarkView, ResourceInput, ResourceQuery, ResourceRecord, ResourceRef } from "./domain.ts";
import type { ProjectResourceSharePort, ResourceCorrectionKind, ResourceCorrectionPort, ResourcePublicationPort, ResourceRepository, ResourceReviewLookupPort, ResourceShareRequest, ResourceUnitOfWork, ReviewedResourceLookupPort } from "./ports.ts";

export interface ResourceServiceDependencies {
  repository: ResourceRepository;
  reviews: ResourceReviewLookupPort;
  clock: Clock;
  ids: IdGenerator;
  projectAccess?: ProjectAccessPort;
  projectSharing?: ProjectResourceSharePort;
  corrections?: ResourceCorrectionPort;
}
function signedIn(actor: Actor | null): Actor {
  if (!actor?.userId) throw new DomainError("AUTHENTICATION_REQUIRED", "请登录后保存个人收藏。", {status: 401, recoveryAction: "login"});
  return actor;
}
function reviewer(actor: Actor): void {
  signedIn(actor);
  if (!actor.platformRoles.some(role => role === "reviewer" || role === "admin")) throw new DomainError("RESOURCE_REVIEW_FORBIDDEN", "只有运营审核人员可以维护公开资源。", {status: 403});
}
function revision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new DomainError("INVALID_REVISION", "请提供资源的预期修订号。");
}
function conflict(latestRevision: number): never {
  throw new DomainError("VERSION_CONFLICT", "这份资料已更新，请查看最新版本后重试。", {status: 409, latestRevision, recoveryAction: "review_latest_version"});
}
async function editable(unit: ResourceUnitOfWork, id: string, expectedRevision: number): Promise<ResourceRecord> {
  resourceText(id, "资源 ID", 200);
  revision(expectedRevision);
  const record = await unit.getRecord(id, true);
  if (!record) throw new DomainError("RESOURCE_NOT_FOUND", "未找到这条资源。", {status: 404});
  if (record.resource.revision !== expectedRevision) conflict(record.resource.revision);
  return record;
}
async function save(unit: ResourceUnitOfWork, record: ResourceRecord, expectedRevision: number): Promise<void> {
  if (!await unit.saveRecord(record, expectedRevision)) conflict((await unit.getRecord(record.resource.id))?.resource.revision ?? expectedRevision);
}
function page<T>(rows: readonly T[], offset: number, limit: number): PageResult<T> {
  return {items: rows.slice(0, limit), nextCursor: rows.length > limit ? String(offset + limit) : null};
}

export class ResourceService implements ResourcePublicationPort, ReviewedResourceLookupPort {
  private readonly deps: ResourceServiceDependencies;
  constructor(deps: ResourceServiceDependencies) { this.deps = deps; }

  categories() {
    return {categories: RESOURCE_CATEGORIES, stageTags: RESOURCE_STAGES, stackTags: RESOURCE_STACKS, useTags: RESOURCE_USES, prerequisites: RESOURCE_PREREQUISITES,
      costTypes: RESOURCE_COST_TYPES, policy: "受控标签；未核实费用和许可保持未知。"};
  }
  async getDraft(actor: Actor, id: string): Promise<Resource> {
    reviewer(actor);
    resourceText(id, "资源 ID", 200);
    const record = await this.deps.repository.getRecord(id);
    if (!record) throw new DomainError("RESOURCE_NOT_FOUND", "未找到这条资源。", {status: 404});
    return record.resource;
  }
  async list(query: ResourceQuery = {}): Promise<PageResult<Resource>> {
    const normalized = normalizeResourceQuery(query);
    return page(await this.deps.repository.listPublished(normalized), normalized.offset, normalized.limit);
  }
  async detail(id: string): Promise<Resource> {
    resourceText(id, "资源 ID", 200);
    const resource = await this.deps.repository.getPublic(id);
    if (!resource) throw new DomainError("RESOURCE_NOT_FOUND", "未找到已公开的资源。", {status: 404});
    return resource;
  }
  async createDraft(actor: Actor, input: ResourceInput): Promise<Resource> {
    reviewer(actor);
    const now = this.deps.clock.now();
    const resource: Resource = {
      ...normalizeResourceInput(input, now), id: this.deps.ids.next(), version: 1, revision: 1,
      publicationStatus: "draft", reviewId: null, publishedAt: null, withdrawnReason: null, externalLinkBlocked: false,
      createdAt: now.toISOString(), updatedAt: now.toISOString(), recordedBy: actor.userId,
    };
    await this.deps.repository.transaction(unit => unit.insertRecord({resource, publicResource: null}));
    return resource;
  }
  async updateDraft(actor: Actor, id: string, expectedRevision: number, input: ResourceInput): Promise<Resource> {
    reviewer(actor);
    const now = this.deps.clock.now();
    const normalized = normalizeResourceInput(input, now);
    return this.deps.repository.transaction(async unit => {
      const record = await editable(unit, id, expectedRevision);
      const resource: Resource = {...record.resource, ...normalized, version: record.resource.version + 1, revision: expectedRevision + 1,
        publicationStatus: "draft", reviewId: null, publishedAt: null, withdrawnReason: null, externalLinkBlocked: false, updatedAt: now.toISOString(), recordedBy: actor.userId};
      await save(unit, {resource, publicResource: record.publicResource}, expectedRevision);
      return resource;
    });
  }
  async requestReview(actor: Actor, id: string, expectedRevision: number): Promise<Resource> {
    reviewer(actor);
    return this.deps.repository.transaction(async unit => {
      const record = await editable(unit, id, expectedRevision);
      if (record.resource.publicationStatus !== "draft") throw new DomainError("RESOURCE_NOT_DRAFT", "请先保存新的资源草稿。", {status: 409});
      const resource: Resource = {...record.resource, publicationStatus: "in_review", revision: expectedRevision + 1, updatedAt: this.deps.clock.now().toISOString()};
      await save(unit, {resource, publicResource: record.publicResource}, expectedRevision);
      return resource;
    });
  }
  async publish(actor: Actor, id: string, expectedRevision: number, reviewId: string): Promise<Resource> {
    reviewer(actor);
    resourceText(reviewId, "审核 ID", 200);
    // Review is looked up through a server-owned port, never accepted as request evidence.
    const review = await this.deps.reviews.getApprovedReview(reviewId);
    return this.deps.repository.transaction(async unit => {
      const record = await editable(unit, id, expectedRevision);
      const current = record.resource;
      if (current.publicationStatus !== "in_review") throw new DomainError("RESOURCE_NOT_IN_REVIEW", "请先提交当前草稿进行人工审核。", {status: 409});
      if (!review || review.result !== "approved" || review.id !== reviewId || review.resourceId !== id || review.resourceVersion !== current.version || !review.reviewerId) {
        throw new DomainError("RESOURCE_REVIEW_REQUIRED", "当前内容版本尚未获得人工审核。", {status: 409});
      }
      const now = this.deps.clock.now();
      const checkedAt = resourceInstant(review.checkedAt, "审核时间", now);
      const sources = review.sourceLinks.map(url => resourceUrl(url, "审核来源"));
      const requiredSources = [current.officialUrl, ...(current.costType === "unknown" ? [] : [current.costSourceUrl!]), ...(current.licenseStatus === "unknown" ? [] : [current.licenseSourceUrl!])];
      const evidenceTimes = [current.verifiedAt, current.costVerifiedAt, current.licenseVerifiedAt].filter((v): v is string => v !== null);
      if (!checkedAt || !current.verifiedAt || current.linkStatus !== "available" || evidenceTimes.some(time => Date.parse(time) > Date.parse(checkedAt)) || requiredSources.some(url => !sources.includes(url))) {
        throw new DomainError("RESOURCE_REVIEW_EVIDENCE_INVALID", "审核需要覆盖当前链接及已确认的费用和许可来源。", {status: 409});
      }
      const resource: Resource = {...current, publicationStatus: "published", reviewId, publishedAt: now.toISOString(), withdrawnReason: null,
        externalLinkBlocked: false, revision: expectedRevision + 1, updatedAt: now.toISOString()};
      await save(unit, {resource, publicResource: resource}, expectedRevision);
      return resource;
    });
  }
  async withdraw(actor: Actor, id: string, expectedRevision: number, reason: string, blockExternalLink: boolean): Promise<Resource> {
    reviewer(actor);
    const withdrawnReason = resourceText(reason, "下架原因", 1000);
    if (typeof blockExternalLink !== "boolean") throw new DomainError("INVALID_RESOURCE_INPUT", "请明确是否阻断外链。");
    return this.deps.repository.transaction(async unit => {
      const record = await editable(unit, id, expectedRevision);
      if (!record.publicResource || record.publicResource.publicationStatus !== "published") throw new DomainError("RESOURCE_NOT_PUBLISHED", "这条资源目前没有可撤下的公开版本。", {status: 409});
      const now = this.deps.clock.now().toISOString();
      const publicResource: Resource = {...record.publicResource, publicationStatus: "withdrawn", withdrawnReason, externalLinkBlocked: blockExternalLink, revision: expectedRevision + 1, updatedAt: now};
      const resource: Resource = record.resource.publicationStatus === "draft" || record.resource.publicationStatus === "in_review"
        ? {...record.resource, publicationStatus: "draft", version: record.resource.version + 1, reviewId: null, revision: expectedRevision + 1, updatedAt: now}
        : publicResource;
      await save(unit, {resource, publicResource}, expectedRevision);
      return publicResource;
    });
  }
  async getReviewedResources(ids: readonly string[], transaction?: SqlExecutor): Promise<readonly Resource[]> {
    if (!Array.isArray(ids) || ids.length > 50) throw new DomainError("INVALID_RESOURCE_REFS", "一次最多核查 50 条资源。");
    const uniqueIds = [...new Set(ids.map(id => resourceText(id, "资源 ID", 200)))];
    let resources: readonly (Resource | null)[];
    if (transaction) {
      const repository = createResourceRepositoryInTransaction(transaction);
      const locked = new Map<string, Resource | null>();
      // Stable lock order prevents two plans from locking the same resources in reverse order.
      for (const id of [...uniqueIds].sort()) locked.set(id, (await repository.getRecord(id, true))?.publicResource ?? null);
      resources = uniqueIds.map(id => locked.get(id) ?? null);
    } else resources = await Promise.all(uniqueIds.map(id => this.deps.repository.getPublic(id)));
    return resources.filter((resource): resource is Resource => resource !== null && isReviewedResource(resource));
  }
  async getReviewedResource(id: string, transaction?: SqlExecutor): Promise<{id: string; title: string} | null> {
    const resource = (await this.getReviewedResources([id], transaction))[0];
    return resource ? {id: resource.id, title: resource.name} : null;
  }
  async getDisplayableApprovedIds(ids: readonly string[], transaction?: SqlExecutor): Promise<readonly string[]> {
    return (await this.getReviewedResources(ids, transaction)).map(resource => resource.id);
  }
  async validateResourceRefs(refs: readonly ResourceRef[], transaction?: SqlExecutor): Promise<readonly ResourceRef[]> {
    if (!Array.isArray(refs) || refs.length > 50) throw new DomainError("INVALID_RESOURCE_REFS", "一次最多引用 50 条资源。");
    for (const ref of refs) {
      if (!ref || typeof ref.resourceId !== "string" || !Number.isSafeInteger(ref.version) || ref.version < 1) throw new DomainError("INVALID_RESOURCE_REFS", "资源引用需要 ID 和内容版本。");
    }
    const found = new Map((await this.getReviewedResources(refs.map(ref => ref.resourceId), transaction)).map(resource => [resource.id, resource]));
    if (refs.some(ref => found.get(ref.resourceId)?.version !== ref.version)) throw new DomainError("RESOURCE_REFS_UNAVAILABLE", "部分资源未审核、已下架或已更新，请移除这些引用后继续。", {status: 409, recoveryAction: "refresh_resource_refs"});
    return [...new Map(refs.map(ref => [ref.resourceId, {resourceId: ref.resourceId, version: ref.version}])).values()];
  }
  async listBookmarks(actor: Actor | null, query: Pick<ResourceQuery, "cursor" | "limit"> = {}): Promise<PageResult<ResourceBookmarkView>> {
    const owner = signedIn(actor);
    const normalized = normalizeResourceQuery(query);
    return page(await this.deps.repository.listBookmarks(owner.userId, normalized.offset, normalized.limit), normalized.offset, normalized.limit);
  }
  async bookmark(actor: Actor | null, resourceId: string, purposeNote = ""): Promise<ResourceBookmark> {
    const owner = signedIn(actor);
    resourceText(resourceId, "资源 ID", 200);
    const note = resourceText(purposeNote, "参考目的", 1000, true);
    return this.deps.repository.transaction(async unit => {
      const record = await unit.getRecord(resourceId, true);
      if (!record?.publicResource || record.publicResource.publicationStatus !== "published" || record.publicResource.externalLinkBlocked) throw new DomainError("RESOURCE_NOT_BOOKMARKABLE", "当前资源尚未发布或已下架；已有收藏仍会保留。", {status: 409});
      const now = this.deps.clock.now().toISOString();
      return unit.putBookmark({id: this.deps.ids.next(), userId: owner.userId, resourceId, purposeNote: note, revision: 1, createdAt: now, updatedAt: now});
    });
  }
  async updateBookmark(actor: Actor | null, id: string, expectedRevision: number, purposeNote: string): Promise<ResourceBookmark> {
    const owner = signedIn(actor);
    resourceText(id, "收藏 ID", 200);
    revision(expectedRevision);
    const note = resourceText(purposeNote, "参考目的", 1000, true);
    return this.deps.repository.transaction(async unit => {
      const bookmark = await unit.getBookmark(id, owner.userId, true);
      if (!bookmark) throw new DomainError("BOOKMARK_NOT_FOUND", "未找到你的个人收藏。", {status: 404});
      if (bookmark.revision !== expectedRevision) conflict(bookmark.revision);
      const updated: ResourceBookmark = {...bookmark, purposeNote: note, revision: expectedRevision + 1, updatedAt: this.deps.clock.now().toISOString()};
      if (!await unit.updateBookmark(updated, expectedRevision)) conflict((await unit.getBookmark(id, owner.userId))?.revision ?? expectedRevision);
      return updated;
    });
  }
  async removeBookmark(actor: Actor | null, id: string): Promise<void> {
    const owner = signedIn(actor);
    resourceText(id, "收藏 ID", 200);
    await this.deps.repository.transaction(unit => unit.removeBookmark(id, owner.userId));
  }
  async shareBookmark(actor: Actor | null, bookmarkId: string, projectId: string, purposeNote?: string): Promise<{id: string; projectId: string}> {
    const owner = signedIn(actor);
    resourceText(bookmarkId, "收藏 ID", 200);
    resourceText(projectId, "项目 ID", 200);
    const bookmark = await this.deps.repository.getBookmark(bookmarkId, owner.userId);
    if (!bookmark) throw new DomainError("BOOKMARK_NOT_FOUND", "未找到你的个人收藏。", {status: 404});
    const resource = await this.detail(bookmark.resourceId);
    return this.shareResource(owner, {projectId, resourceId: resource.id, resourceVersion: resource.version, purposeNote: purposeNote ?? bookmark.purposeNote});
  }
  async shareResource(actor: Actor | null, input: ResourceShareRequest): Promise<{id: string; projectId: string}> {
    const owner = signedIn(actor);
    const projectId = resourceText(input.projectId, "项目 ID", 200);
    const resourceId = resourceText(input.resourceId, "资源 ID", 200);
    const purposeNote = resourceText(input.purposeNote, "共享备注", 1000, true);
    revision(input.resourceVersion);
    if (!this.deps.projectAccess || !this.deps.projectSharing) throw new DomainError("PROJECT_RESOURCE_SHARING_UNAVAILABLE", "项目资料服务暂未接入，个人收藏已保留。", {status: 503});
    const membership = await this.deps.projectAccess.getMembership(projectId, owner.userId);
    if (!membership || membership.status !== "active" || membership.userId !== owner.userId || membership.projectId !== projectId) throw new DomainError("PROJECT_ACCESS_FORBIDDEN", "你已不在这个项目中，无法共享资料。", {status: 403});
    const resource = await this.detail(resourceId);
    if (!isReviewedResource(resource)) throw new DomainError("RESOURCE_NOT_SHAREABLE", "当前资源无法作为已审核资料共享。", {status: 409});
    if (resource.version !== input.resourceVersion) throw new DomainError("RESOURCE_REFS_UNAVAILABLE", "这条资源已更新，请查看最新内容后再共享。", {status: 409, recoveryAction: "refresh_resource_refs"});
    const shared = await this.deps.projectSharing.addReviewedResource(owner, {projectId, resourceId: resource.id, resourceVersion: resource.version,
      title: resource.name, url: resource.officialUrl, purposeNote});
    if (!shared?.id || shared.projectId !== projectId) throw new DomainError("PROJECT_RESOURCE_SHARING_RESULT_UNKNOWN", "暂未收到有效的共享结果，请核对项目资料后重试。个人收藏已保留。", {status: 503, recoveryAction: "refresh_project_resources"});
    return shared;
  }
  async reportCorrection(actor: Actor | null, input: {resourceId: string; kind: ResourceCorrectionKind; note: string}): Promise<{id: string}> {
    await this.detail(input.resourceId);
    const note = resourceText(input.note, "纠错说明", 1000);
    if (!["broken_link", "cost", "license", "other"].includes(input.kind)) throw new DomainError("INVALID_CORRECTION_KIND", "请选择纠错类型。");
    if (!this.deps.corrections) throw new DomainError("RESOURCE_CORRECTIONS_UNAVAILABLE", "纠错服务暂未接入，请稍后再试。", {status: 503});
    return this.deps.corrections.submit(actor, {resourceId: input.resourceId, kind: input.kind, note});
  }
}
