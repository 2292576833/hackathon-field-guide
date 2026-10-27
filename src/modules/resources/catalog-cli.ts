import { createHash } from "node:crypto";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { normalizeResourceInput, resourceInstant, resourceText, resourceUrl } from "./domain.ts";
import type { Resource, ResourceInput } from "./domain.ts";
import type { CatalogEvidence, CatalogImportScope, CatalogImportStage, CatalogReviewRecord, CatalogReviewVerification, ResourceCatalogCheckpoint, ResourceCatalogCliDependencies, ResourceCatalogEntry } from "./catalog-types.ts";

interface Options {
  import: boolean;
  review: boolean;
  publish: boolean;
  confirmLinks: boolean;
  acknowledgeUnknown: boolean;
  keys: readonly string[] | null;
  reason: string | null;
}
export interface ResourceCatalogCliItemResult {
  readonly candidateKey: string;
  readonly catalogVersion: string;
  readonly contentHash: string;
  readonly resourceId: string | null;
  readonly stage: "preview" | CatalogImportStage;
  readonly reused: boolean;
  readonly name: string;
  readonly officialUrl: string;
  readonly costType: ResourceInput["costType"];
  readonly licenseStatus: ResourceInput["licenseStatus"];
  readonly linkStatus: ResourceInput["linkStatus"];
  readonly remainingChecks: readonly string[];
  readonly evidence: readonly CatalogEvidence[];
}
export interface ResourceCatalogCliResult {
  readonly mode: "dry-run" | "import";
  readonly items: readonly ResourceCatalogCliItemResult[];
}

function invalid(message: string): never {
  throw new DomainError("CATALOG_INVALID_ARGUMENTS", message);
}
function options(args: readonly string[]): Options {
  const parsed: Options = {import: false, review: false, publish: false, confirmLinks: false, acknowledgeUnknown: false, keys: null, reason: null};
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (typeof arg !== "string" || !["--import", "--dry-run", "--review", "--publish", "--confirm-links", "--ack-unknown", "--keys", "--review-reason"].includes(arg)) {
      invalid("包含不支持的 CLI 参数；账号和权限必须由可信登录配置加载。");
    }
    if (seen.has(arg)) invalid(`参数 ${arg} 不能重复。`);
    seen.add(arg);
    if (arg === "--keys" || arg === "--review-reason") {
      const value = args[++index];
      if (typeof value !== "string" || !value.trim() || value.startsWith("--")) invalid(`请为 ${arg} 提供内容。`);
      if (arg === "--keys") {
        const keys = value.split(",").map(key => key.trim());
        if (keys.some(key => !key || key.length > 200)) invalid("--keys 需要用逗号分隔有效候选 ID。");
        parsed.keys = [...new Set(keys)];
      } else parsed.reason = resourceText(value, "审核理由", 1000);
    } else if (arg === "--import") parsed.import = true;
    else if (arg === "--review") parsed.review = true;
    else if (arg === "--publish") parsed.publish = true;
    else if (arg === "--confirm-links") parsed.confirmLinks = true;
    else if (arg === "--ack-unknown") parsed.acknowledgeUnknown = true;
  }
  if (seen.has("--dry-run") && parsed.import) invalid("--dry-run 和 --import 不能同时使用。");
  if (parsed.review && (!parsed.import || !parsed.reason || !parsed.confirmLinks)) invalid("--review 必须同时提供 --import、--review-reason 和人工核验官方链接后的 --confirm-links。");
  if (parsed.publish && !parsed.review) invalid("--publish 必须同时提供 --review；发布须经过 M08 人工审核。");
  if (parsed.reason && !parsed.review) invalid("--review-reason 需要与 --review 一起使用。");
  return parsed;
}

function reviewer(actor: Actor): void {
  if (!actor?.userId) throw new DomainError("AUTHENTICATION_REQUIRED", "请配置可信审核人员身份后再导入资源。", {status: 401});
  if (!Array.isArray(actor.platformRoles) || !actor.platformRoles.some(role => role === "reviewer" || role === "admin")) {
    throw new DomainError("RESOURCE_REVIEW_FORBIDDEN", "资源导入和审核需要真实审核人员或管理员权限。", {status: 403});
  }
}
function sortedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, child]) => [key, sortedValue(child)]));
  return value;
}
/** Stable catalog fingerprint; manual link confirmation time is deliberately outside it. */
export function resourceCatalogEntryHash(entry: ResourceCatalogEntry): string {
  return createHash("sha256").update(JSON.stringify(sortedValue(entry))).digest("hex");
}
function validate(entry: ResourceCatalogEntry, now: Date): void {
  resourceText(entry.candidateKey, "候选 ID", 200);
  resourceText(entry.catalogVersion, "目录版本", 100);
  resourceText(entry.verificationDate, "目录核验日期", 100);
  if (entry.reviewStatus !== "candidate") throw new DomainError("INVALID_CATALOG_ENTRY", "目录条目必须保留候选状态，不能将网页查阅冒充发布审核。");
  normalizeResourceInput(entry.input, now);
  if (!Array.isArray(entry.evidence) || !Array.isArray(entry.remainingChecks)) throw new DomainError("INVALID_CATALOG_ENTRY", "目录条目需要证据与待核验说明。");
  for (const evidence of entry.evidence) {
    if (!["purpose", "cost", "license", "access"].includes(evidence.field)) throw new DomainError("INVALID_CATALOG_ENTRY", "目录证据类型无效。");
    resourceUrl(evidence.url, "目录证据来源");
    if (!resourceInstant(evidence.checkedAt, "目录查阅时间", now)) throw new DomainError("INVALID_CATALOG_ENTRY", "目录证据需要已发生的查阅时间。");
    resourceText(evidence.note, "目录证据说明", 1000);
  }
  for (const check of entry.remainingChecks) resourceText(check, "待核验事项", 1000);
}
function assertCheckpoint(checkpoint: ResourceCatalogCheckpoint, entry: ResourceCatalogEntry, contentHash: string): void {
  if (checkpoint.candidateKey !== entry.candidateKey || checkpoint.catalogVersion !== entry.catalogVersion || checkpoint.contentHash !== contentHash) {
    throw new DomainError("CATALOG_ENTRY_CONFLICT", `候选 ${entry.candidateKey} 已有不同目录版本或内容的导入记录，请人工核对；不会覆盖现有资源。`, {status: 409, recoveryAction: "review_catalog_checkpoint"});
  }
}
function assertCurrent(checkpoint: ResourceCatalogCheckpoint, current: Resource): void {
  const expected = checkpoint.stage === "imported" ? "draft" : checkpoint.stage === "published" ? "published" : "in_review";
  if (current.id !== checkpoint.resourceId || current.revision !== checkpoint.resourceRevision || current.publicationStatus !== expected
    || checkpoint.stage === "published" && current.reviewId !== checkpoint.reviewId) {
    throw new DomainError("CATALOG_RESOURCE_CHANGED", "已导入资源被修改或状态已变化，请人工核对当前资源后继续。", {status: 409, latestRevision: current.revision, recoveryAction: "review_latest_version"});
  }
}
function assertReview(checkpoint: ResourceCatalogCheckpoint, review: CatalogReviewRecord): void {
  if (review.id !== checkpoint.reviewId || review.resourceId !== checkpoint.resourceId || review.resourceRevision !== checkpoint.resourceRevision || review.revision !== checkpoint.reviewRevision) {
    throw new DomainError("CATALOG_REVIEW_CHANGED", "审核记录与导入检查点不一致，请人工核对当前审核。", {status: 409, recoveryAction: "review_latest_version"});
  }
}
function invalidResult(): never {
  throw new DomainError("CATALOG_INVALID_RESULT", "资源或审核服务未返回匹配的真实结果，请核对检查点后重试。", {status: 503});
}
function requireEvidence(entry: ResourceCatalogEntry, field: "cost" | "license", source: string | null): void {
  if (!source || !entry.evidence.some(evidence => evidence.field === field && resourceUrl(evidence.url) === resourceUrl(source))) {
    throw new DomainError("CATALOG_EVIDENCE_REQUIRED", "目录中的已确认费用或许可缺少相应官方来源证据；请人工补足或明确改为未知。", {status: 409});
  }
}
function verification(entry: ResourceCatalogEntry, current: Resource): CatalogReviewVerification {
  if (current.costType !== "unknown") requireEvidence(entry, "cost", current.costSourceUrl);
  if (current.licenseStatus !== "unknown") requireEvidence(entry, "license", current.licenseSourceUrl);
  return {link: {status: "available", checkedUrl: current.officialUrl},
    fees: current.costType === "unknown" ? {status: "unknown", sourceUrl: null} : {status: "verified", sourceUrl: current.costSourceUrl},
    license: current.licenseStatus === "unknown" ? {status: "unknown", sourceUrl: null} : {status: "verified", sourceUrl: current.licenseSourceUrl}};
}

/** Executable command factory. The coordinator supplies identity and transaction-bound ports. */
export function createResourceCatalogCli(deps: ResourceCatalogCliDependencies) {
  async function persist(scope: CatalogImportScope, checkpoint: ResourceCatalogCheckpoint, fields: Partial<ResourceCatalogCheckpoint>): Promise<ResourceCatalogCheckpoint> {
    const updated: ResourceCatalogCheckpoint = {...checkpoint, ...fields, updatedAt: deps.clock.now().toISOString(), revision: checkpoint.revision + 1};
    await scope.checkpoints.save(updated, checkpoint.revision);
    return updated;
  }
  async function read(scope: CatalogImportScope, actor: Actor, entry: ResourceCatalogEntry, contentHash: string) {
    const checkpoint = await scope.checkpoints.lock(entry.candidateKey);
    if (!checkpoint) throw new DomainError("CATALOG_CHECKPOINT_MISSING", "导入检查点不存在，请重新执行明确的导入操作。", {status: 409});
    assertCheckpoint(checkpoint, entry, contentHash);
    const current = await scope.resources.getDraft(actor, checkpoint.resourceId);
    assertCurrent(checkpoint, current);
    return {checkpoint, current};
  }
  async function importEntry(actor: Actor, entry: ResourceCatalogEntry, contentHash: string, opts: Options) {
    return deps.runEach(async scope => {
      const existing = await scope.checkpoints.lock(entry.candidateKey);
      if (existing) {
        assertCheckpoint(existing, entry, contentHash);
        const current = await scope.resources.getDraft(actor, existing.resourceId);
        assertCurrent(existing, current);
        return {checkpoint: existing, current, reused: true};
      }
      const now = deps.clock.now().toISOString();
      const input: ResourceInput = {...entry.input, linkStatus: opts.confirmLinks ? "available" : "unknown", verifiedAt: opts.confirmLinks ? now : null};
      const current = await scope.resources.createDraft(actor, input);
      if (!current?.id || current.publicationStatus !== "draft" || current.recordedBy !== actor.userId || !Number.isSafeInteger(current.revision) || current.revision < 1) invalidResult();
      const checkpoint: ResourceCatalogCheckpoint = {candidateKey: entry.candidateKey, catalogVersion: entry.catalogVersion, contentHash,
        resourceId: current.id, resourceRevision: current.revision, reviewId: null, reviewRevision: null, stage: "imported",
        importedBy: actor.userId, importedAt: now, updatedAt: now, revision: 1};
      await scope.checkpoints.insert(checkpoint);
      return {checkpoint, current, reused: false};
    });
  }
  async function reviewEntry(actor: Actor, entry: ResourceCatalogEntry, contentHash: string, opts: Options) {
    return deps.runEach(async scope => {
      let {checkpoint, current} = await read(scope, actor, entry, contentHash);
      if (checkpoint.stage === "published") return {checkpoint, current};
      if (checkpoint.stage === "approved") {
        if (!checkpoint.reviewId) invalidResult();
        const {review} = await scope.reviews.getDetail(actor, checkpoint.reviewId);
        assertReview(checkpoint, review);
        if (review.status !== "approved") throw new DomainError("CATALOG_REVIEW_CHANGED", "已批准审核的状态已变化，请人工核对。", {status: 409});
        return {checkpoint, current};
      }
      if (checkpoint.stage === "imported") {
        // The operator's explicit confirmation, not catalog browsing, supplies current access evidence.
        const updated = await scope.resources.updateDraft(actor, current.id, current.revision, {...entry.input, linkStatus: "available", verifiedAt: deps.clock.now().toISOString()});
        if (updated.id !== current.id || updated.revision !== current.revision + 1 || updated.publicationStatus !== "draft") invalidResult();
        current = await scope.resources.requestReview(actor, updated.id, updated.revision);
        if (current.id !== updated.id || current.revision !== updated.revision + 1) invalidResult();
      }
      if (current.publicationStatus !== "in_review" || current.linkStatus !== "available" || !current.verifiedAt) invalidResult();
      let review: CatalogReviewRecord;
      if (checkpoint.reviewId) {
        review = (await scope.reviews.getDetail(actor, checkpoint.reviewId)).review;
        assertReview(checkpoint, review);
      } else review = await scope.reviews.register(actor, {resourceId: current.id, expectedResourceRevision: current.revision}, deps.requestIds.next());
      if (review.resourceId !== current.id || review.resourceRevision !== current.revision || !review.id || !Number.isSafeInteger(review.revision) || review.revision < 1) invalidResult();
      if (review.status !== "pending" && review.status !== "changes_requested") throw new DomainError("CATALOG_REVIEW_CHANGED", "当前审核已被其他操作处理，请人工核对。", {status: 409});
      const registered = review;
      review = await scope.reviews.decide(actor, review.id, {expectedRevision: review.revision, expectedResourceRevision: current.revision,
        decision: "approved", reason: opts.reason!, verification: verification(entry, current)}, deps.requestIds.next());
      if (review.id !== registered.id || review.revision !== registered.revision + 1 || review.status !== "approved" || review.resourceId !== current.id || review.resourceRevision !== current.revision) invalidResult();
      checkpoint = await persist(scope, checkpoint, {resourceRevision: current.revision, reviewId: review.id, reviewRevision: review.revision, stage: "approved"});
      return {checkpoint, current};
    });
  }
  async function publishEntry(actor: Actor, entry: ResourceCatalogEntry, contentHash: string) {
    return deps.runEach(async scope => {
      let {checkpoint, current} = await read(scope, actor, entry, contentHash);
      if (checkpoint.stage === "published") return {checkpoint, current};
      if (checkpoint.stage !== "approved" || !checkpoint.reviewId) throw new DomainError("CATALOG_REVIEW_REQUIRED", "发布前必须完成当前版本的 M08 审核。", {status: 409});
      const {review} = await scope.reviews.getDetail(actor, checkpoint.reviewId);
      assertReview(checkpoint, review);
      if (review.status !== "approved") throw new DomainError("CATALOG_REVIEW_CHANGED", "当前审核尚未批准或已被更新。", {status: 409});
      const published = await scope.reviews.publish(actor, review.id, {expectedRevision: review.revision, expectedResourceRevision: current.revision}, deps.requestIds.next());
      if (published.id !== review.id || published.resourceId !== current.id || published.resourceRevision !== current.revision || published.status !== "published" || published.revision <= review.revision) invalidResult();
      current = await scope.resources.getDraft(actor, current.id);
      if (current.publicationStatus !== "published" || current.reviewId !== published.id || current.revision <= checkpoint.resourceRevision) invalidResult();
      checkpoint = await persist(scope, checkpoint, {resourceRevision: current.revision, reviewRevision: published.revision, stage: "published"});
      return {checkpoint, current};
    });
  }
  function result(entry: ResourceCatalogEntry, contentHash: string, current: Resource | null, checkpoint: ResourceCatalogCheckpoint | null, reused: boolean): ResourceCatalogCliItemResult {
    return {candidateKey: entry.candidateKey, catalogVersion: entry.catalogVersion, contentHash, resourceId: current?.id ?? null,
      stage: checkpoint?.stage ?? "preview", reused, name: current?.name ?? entry.input.name, officialUrl: current?.officialUrl ?? entry.input.officialUrl,
      costType: current?.costType ?? entry.input.costType, licenseStatus: current?.licenseStatus ?? entry.input.licenseStatus,
      linkStatus: current?.linkStatus ?? "unknown", remainingChecks: [...entry.remainingChecks], evidence: structuredClone(entry.evidence)};
  }
  return {
    async run(args: readonly string[]): Promise<ResourceCatalogCliResult> {
      const opts = options(args);
      const byKey = new Map<string, ResourceCatalogEntry>();
      for (const entry of deps.entries) {
        if (byKey.has(entry.candidateKey)) throw new DomainError("INVALID_CATALOG_ENTRY", "目录中存在重复候选 ID。");
        byKey.set(entry.candidateKey, entry);
      }
      const entries = opts.keys === null ? [...deps.entries] : opts.keys.map(key => {
        const entry = byKey.get(key);
        if (!entry) invalid(`未找到候选 ${key}，请核对 --keys。`);
        return entry;
      });
      for (const entry of entries) {
        validate(entry, deps.clock.now());
        if (opts.review && !opts.acknowledgeUnknown && (entry.input.costType === "unknown" || entry.input.licenseStatus === "unknown")) {
          invalid("审核含未知费用或许可的条目时，必须用 --ack-unknown 明确保留并确认未知状态。");
        }
      }
      if (!opts.import) return {mode: "dry-run", items: entries.map(entry => result(entry, resourceCatalogEntryHash(entry), null, null, false))};
      const actor = await deps.loadTrustedActor();
      reviewer(actor);
      const items: ResourceCatalogCliItemResult[] = [];
      for (const entry of entries) {
        const contentHash = resourceCatalogEntryHash(entry);
        const imported = await importEntry(actor, entry, contentHash, opts);
        let {checkpoint, current} = imported;
        if (opts.review && checkpoint.stage !== "published") ({checkpoint, current} = await reviewEntry(actor, entry, contentHash, opts));
        if (opts.publish && checkpoint.stage !== "published") ({checkpoint, current} = await publishEntry(actor, entry, contentHash));
        items.push(result(entry, contentHash, current, checkpoint, imported.reused));
      }
      return {mode: "import", items};
    },
  };
}
