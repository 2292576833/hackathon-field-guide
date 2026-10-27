import type { Actor, Clock, IdGenerator } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { assertExpectedRevision, normalizeSourceDraft, normalizeVerification, requireOperationsAdmin, requireOperationsReader, requireText, sourceTransitions } from "./source-domain.ts";
import type { SourceConfig, SourceDraft, SourceStatus, SourceVerification } from "./source-domain.ts";
import type { OperationsExecutionRepository } from "./run-repository.ts";

export class SourceService {
  private readonly repository: OperationsExecutionRepository;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  constructor(deps: { repository: OperationsExecutionRepository; clock: Clock; ids: IdGenerator }) { this.repository = deps.repository; this.clock = deps.clock; this.ids = deps.ids; }

  async list(actor: Actor, limit = 50): Promise<readonly SourceConfig[]> {
    requireOperationsReader(actor);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DomainError("INVALID_PAGE_LIMIT", "一次最多读取 100 条来源。");
    return this.repository.listSources(limit);
  }
  async get(actor: Actor, id: string): Promise<SourceConfig> {
    requireOperationsReader(actor);
    const source = await this.repository.getSource(id);
    if (!source) throw new DomainError("SOURCE_NOT_FOUND", "未找到来源配置。", { status: 404 });
    return source;
  }
  async create(actor: Actor, input: SourceDraft): Promise<SourceConfig> {
    requireOperationsAdmin(actor);
    const draft = normalizeSourceDraft(input);
    const now = this.clock.now().toISOString();
    const source: SourceConfig = { ...draft, id: this.ids.next(), revision: 1, status: "proposed", credentialPolicy: "none", verification: null, health: { nextEligibleAt: null, lastSuccessAt: null, lastFailureAt: null, consecutiveFailures: 0 }, createdAt: now, updatedAt: now };
    return this.repository.transaction(async (tx) => {
      await tx.insertSource(source);
      await tx.appendAudit({ id: this.ids.next(), actorKind: "user", actorId: actor.userId, action: "SourceProposed", entityId: source.id, revision: source.revision, reason: "登记待验证来源", occurredAt: now });
      return source;
    });
  }
  /** Replacing network/frequency/acquisition settings invalidates earlier approval. */
  async revise(actor: Actor, id: string, input: { expectedRevision: number; reason: string; config: SourceDraft }): Promise<SourceConfig> {
    requireOperationsAdmin(actor);
    const reason = requireText(input.reason, "修改理由");
    const draft = normalizeSourceDraft(input.config);
    return this.repository.transaction(async (tx) => {
      const source = await tx.getSource(id, true);
      if (!source) throw new DomainError("SOURCE_NOT_FOUND", "未找到来源配置。", { status: 404 });
      assertExpectedRevision(source.revision, input.expectedRevision);
      if (draft.networkPolicy.version <= source.networkPolicy.version) throw new DomainError("NETWORK_POLICY_VERSION_REQUIRED", "修改配置需提供递增的网络规则版本。");
      const now = this.clock.now().toISOString();
      const next = { ...source, ...draft, revision: source.revision + 1, status: "verifying" as const, verification: null, updatedAt: now };
      await tx.saveSource(next, source.revision);
      await tx.appendAudit({ id: this.ids.next(), actorKind: "user", actorId: actor.userId, action: "SourceConfigRevised", entityId: id, revision: next.revision, reason, occurredAt: now });
      return next;
    });
  }
  async transition(actor: Actor, id: string, input: { expectedRevision: number; status: SourceStatus; reason: string; verification?: Omit<SourceVerification, "verifiedAt" | "verifiedBy"> }): Promise<SourceConfig> {
    requireOperationsAdmin(actor);
    const reason = requireText(input.reason, "状态变更理由");
    return this.repository.transaction(async (tx) => {
      const source = await tx.getSource(id, true);
      if (!source) throw new DomainError("SOURCE_NOT_FOUND", "未找到来源配置。", { status: 404 });
      assertExpectedRevision(source.revision, input.expectedRevision);
      if (!sourceTransitions[source.status].includes(input.status)) throw new DomainError("INVALID_SOURCE_TRANSITION", "来源当前状态不允许此变更。");
      const now = this.clock.now().toISOString();
      const verification = input.verification ? normalizeVerification(input.verification, actor, now) : source.verification;
      if (input.status === "enabled" && !verification) throw new DomainError("SOURCE_VERIFICATION_REQUIRED", "来源通过用途与网络验证后才能启用。");
      const next: SourceConfig = { ...source, status: input.status, verification, revision: source.revision + 1, updatedAt: now };
      await tx.saveSource(next, source.revision);
      await tx.appendAudit({ id: this.ids.next(), actorKind: "user", actorId: actor.userId, action: `Source${input.status[0].toUpperCase()}${input.status.slice(1)}`, entityId: id, revision: next.revision, reason, occurredAt: now });
      return next;
    });
  }
}
