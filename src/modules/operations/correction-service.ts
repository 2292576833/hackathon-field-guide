import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { Correction, CorrectionDependencies, CorrectionStatus, CorrectionTarget, CorrectionTransaction, ProcessCorrectionInput, SubmitCorrectionInput } from "./correction-types.ts";

const transitions: Record<CorrectionStatus, readonly CorrectionStatus[]> = {
  received: ["triaging"], triaging: ["confirmed", "needs_more_info", "dismissed"],
  confirmed: ["resolved"], needs_more_info: ["triaging", "resolved"], dismissed: ["resolved"], resolved: [],
};
function authenticated(actor: Actor): void {
  if (!actor.userId) throw new DomainError("UNAUTHENTICATED", "请先登录。", { status: 401 });
}
function reviewer(actor: Actor): void {
  authenticated(actor);
  if (!actor.platformRoles.includes("reviewer") && !actor.platformRoles.includes("admin")) throw new DomainError("OPERATIONS_FORBIDDEN", "需要公开内容审核权限。", { status: 403 });
}
function text(value: string, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new DomainError("INVALID_INPUT", `请填写${label}（最多 ${max} 字）。`);
  return value.trim();
}
function target(value: CorrectionTarget): CorrectionTarget {
  if (!value || !["event", "resource"].includes(value.kind) || typeof value.entityId !== "string" || !value.entityId.trim() || value.entityId.length > 200 || !Number.isSafeInteger(value.version) || value.version < 1) {
    throw new DomainError("INVALID_INPUT", "纠错必须引用公开赛事或资源的明确版本。");
  }
  return { kind: value.kind, entityId: value.entityId.trim(), version: value.version };
}
function evidence(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length > 5) throw new DomainError("INVALID_INPUT", "最多提供 5 个依据链接。");
  return values.map(value => {
    if (typeof value !== "string" || value.length > 2000) throw new DomainError("INVALID_INPUT", "依据链接无效。");
    try {
      const url = new URL(value);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error();
      return url.href;
    } catch { throw new DomainError("INVALID_INPUT", "依据须为不含账号密码的 HTTP(S) 链接。"); }
  });
}
function limit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new DomainError("INVALID_INPUT", "查询数量须为 1 到 100。");
}

/** Only public version references and station statuses; no project/auth escalation or messaging. */
export class CorrectionService {
  readonly dependencies: CorrectionDependencies;
  constructor(dependencies: CorrectionDependencies) { this.dependencies = dependencies; }
  private async get(tx: CorrectionTransaction, id: string): Promise<Correction> {
    const record = await tx.getCorrection(id);
    if (!record) throw new DomainError("NOT_FOUND", "纠错记录不存在。", { status: 404 });
    return record;
  }
  private now(): string { return this.dependencies.clock.now().toISOString(); }
  async submit(actor: Actor, input: SubmitCorrectionInput): Promise<Correction> {
    authenticated(actor);
    const reference = target(input.target);
    const field = text(input.field, "错误字段", 120);
    const message = text(input.message, "纠错说明", 4000);
    const evidenceUrls = evidence(input.evidenceUrls ?? []);
    return this.dependencies.repository.transaction(async tx => {
      if (!await this.dependencies.targets.isPublicVersion(tx, reference)) throw new DomainError("NOT_FOUND", "对应公开版本不存在。", { status: 404 });
      const now = this.now();
      const record: Correction = { id: this.dependencies.ids.next(), submittedBy: actor.userId,
        original: { target: reference, field, message, evidenceUrls, submittedAt: now },
        revision: 1, status: "received", updatedAt: now, response: null, relatedVersion: null };
      await tx.insertCorrection(record);
      return record;
    });
  }
  async getOwn(actor: Actor, id: string): Promise<Correction> {
    authenticated(actor);
    return this.dependencies.repository.transaction(async tx => {
      const record = await this.get(tx, id);
      // Same 404 avoids disclosing another user's request.
      if (record.submittedBy !== actor.userId) throw new DomainError("NOT_FOUND", "纠错记录不存在。", { status: 404 });
      return record;
    });
  }
  async listOwn(actor: Actor, queryLimit = 50): Promise<readonly Correction[]> {
    authenticated(actor); limit(queryLimit);
    return this.dependencies.repository.listOwn(actor.userId, queryLimit);
  }
  async listQueue(actor: Actor, status?: CorrectionStatus, queryLimit = 50): Promise<readonly Correction[]> {
    reviewer(actor); limit(queryLimit);
    if (status !== undefined && !Object.hasOwn(transitions, status)) throw new DomainError("INVALID_INPUT", "纠错状态无效。");
    return this.dependencies.repository.listQueue(status, queryLimit);
  }
  async getForReview(actor: Actor, id: string): Promise<Correction> {
    reviewer(actor);
    return this.dependencies.repository.transaction(tx => this.get(tx, id));
  }
  async process(actor: Actor, id: string, input: ProcessCorrectionInput, requestId: string): Promise<Correction> {
    reviewer(actor);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new DomainError("INVALID_INPUT", "版本必须为正整数。");
    const reason = text(input.reason, "站内处理说明", 2000);
    if (!Object.hasOwn(transitions, input.status)) throw new DomainError("INVALID_INPUT", "纠错状态无效。");
    const related = input.relatedVersion ? target(input.relatedVersion) : null;
    return this.dependencies.repository.transaction(async tx => {
      const record = await this.get(tx, id);
      if (record.revision !== input.expectedRevision) throw new DomainError("VERSION_CONFLICT", "纠错已由其他审核员处理，请查看最新状态。", { status: 409, latestRevision: record.revision, recoveryAction: "review_latest_version" });
      if (!transitions[record.status].includes(input.status)) throw new DomainError("INVALID_CORRECTION_STATE", "请按接收、核查、结论、解决的顺序处理纠错。", { status: 409 });
      if (related && (related.kind !== record.original.target.kind || related.entityId !== record.original.target.entityId)) throw new DomainError("INVALID_RELATED_VERSION", "处理结果必须关联同一公开内容的版本。");
      if (related && !await this.dependencies.targets.isPublicVersion(tx, related)) throw new DomainError("NOT_FOUND", "关联的公开版本不存在。", { status: 404 });
      if (record.status === "confirmed" && input.status === "resolved" && !related) throw new DomainError("RESOLUTION_VERSION_REQUIRED", "已确认的纠错须关联修正后的公开版本。 ");
      if (record.status === "confirmed" && input.status === "resolved" && related && related.version <= record.original.target.version) throw new DomainError("RESOLUTION_VERSION_REQUIRED", "已确认的纠错须关联更新的公开版本。");
      const now = this.now();
      const updated: Correction = { ...record, revision: record.revision + 1, status: input.status,
        updatedAt: now, response: reason, relatedVersion: related ?? record.relatedVersion };
      await tx.saveCorrection(updated, record.revision);
      await tx.appendTransition({ id: this.dependencies.ids.next(), correctionId: id, revision: updated.revision,
        actorId: actor.userId, fromStatus: record.status, toStatus: input.status, reason,
        relatedVersion: updated.relatedVersion, occurredAt: now, requestId });
      return updated;
    });
  }
}
