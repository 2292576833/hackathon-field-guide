import { timingSafeEqual } from "node:crypto";
import type { Clock, IdGenerator } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { AuthCryptoPort } from "./ports.ts";
import type { AccountDeletionImpactPort, AccountEmailPort, AccountStorePort, AccountTransaction, OwnDataExportPort } from "./account-ports.ts";
import { DEFAULT_ACCOUNT_COMPLETION_POLICY, type AccountCompletionPolicy, type AccountDataOverview, type AccountDeletionRequest,
  type AccountDeletionSummary, type DataExportSummary, type DeletionImpact, type EmailChangeReceipt, type EmailChangeResult,
  type OwnDataBundle, type OwnDataDocument, type StoredDataExport } from "./account-types.ts";
import { normalizeLoginEmail } from "./service.ts";
import { toActor, toProfile } from "./types.ts";

export interface AccountCompletionDependencies {
  readonly store: AccountStorePort; readonly crypto: AuthCryptoPort; readonly email: AccountEmailPort;
  readonly ownData: OwnDataExportPort; readonly deletionImpact: AccountDeletionImpactPort;
  readonly clock: Clock; readonly ids: IdGenerator; readonly policy?: Partial<AccountCompletionPolicy>;
}
const error = (code: string, message: string, status = 422, recoveryAction?: string) => new DomainError(code, message, { status, recoveryAction });
const revisionConflict = (revision: number) => new DomainError("VERSION_CONFLICT", "记录已更新，请刷新后核对再操作。", { status: 409, latestRevision: revision, recoveryAction: "review_latest_version" });
function exportSummary(value: StoredDataExport): DataExportSummary {
  return { id: value.id, status: value.status, createdAt: value.createdAt, updatedAt: value.updatedAt,
    expiresAt: value.expiresAt, revision: value.revision, attempts: value.attempts, errorCode: value.errorCode, byteLength: value.byteLength };
}
function deletionSummary(value: AccountDeletionRequest): AccountDeletionSummary {
  return { id: value.id, status: value.status, createdAt: value.createdAt, updatedAt: value.updatedAt, revision: value.revision, impact: value.impact };
}

/** All methods accept trusted cookie tokens; no owner identity is accepted from browser JSON. */
export class AccountCompletionService {
  private readonly deps: AccountCompletionDependencies;
  private readonly policy: AccountCompletionPolicy;
  constructor(deps: AccountCompletionDependencies) {
    this.deps = deps; this.policy = { ...DEFAULT_ACCOUNT_COMPLETION_POLICY, ...deps.policy };
    if (Object.values(this.policy).some((n) => !Number.isSafeInteger(n) || n <= 0)
      || this.policy.sendCooldownMs > this.policy.rateWindowMs || this.policy.maxExportBytes > 20 * 1024 * 1024) {
      throw new Error("Invalid account completion policy.");
    }
  }

  async getDataOverview(token: string | null | undefined): Promise<AccountDataOverview> {
    return this.deps.store.withSession(this.tokenHash(token), async (tx) => {
      const impact = this.validateImpact(await this.deps.deletionImpact.inspectOwnDeletion(toActor(tx.context.user), tx.executor));
      const exports = [];
      for (const item of (await tx.listExports()).slice(0, 20)) exports.push(exportSummary(await this.expireExport(tx, item)));
      const deletion = await tx.getDeletion();
      await tx.assertSession();
      return { exports, deletionRequest: deletion ? deletionSummary(deletion) : null, impact };
    });
  }

  async requestExport(token: string | null | undefined): Promise<DataExportSummary> {
    return this.deps.store.withSession(this.tokenHash(token), async (tx) => {
      const key = this.deps.crypto.hashRateKey("account-export-user", tx.context.user.id);
      if (!await tx.takeRates([{ key, windowMs: this.policy.exportWindowMs, maximum: this.policy.maxExportsPerWindow }])) {
        throw error("ACCOUNT_EXPORT_RATE_LIMITED", "数据导出请求已达本轮限额，请稍后再试。", 429, "wait_and_retry");
      }
      const now = tx.now();
      const value: StoredDataExport = { id: this.deps.ids.next(), userId: tx.context.user.id, status: "queued",
        createdAt: now, updatedAt: now, expiresAt: new Date(Date.parse(now) + this.policy.exportLifetimeMs).toISOString(),
        revision: 1, attempts: 0, errorCode: null, byteLength: null, document: null };
      await tx.assertSession(); await tx.saveExport(value); await tx.audit("data_export_requested", "data_export", value.id, "queued");
      return exportSummary(value);
    });
  }

  async prepareExport(token: string | null | undefined, id: string, expectedRevision: number): Promise<DataExportSummary> {
    this.id(id); this.revision(expectedRevision); const hash = this.tokenHash(token);
    let collectionStarted = false;
    try {
      return await this.deps.store.withSession(hash, async (tx) => {
        const record = await tx.getExport(id);
        if (!record) throw error("ACCOUNT_EXPORT_NOT_FOUND", "导出请求不可见或不存在。", 404);
        if (record.revision !== expectedRevision) throw revisionConflict(record.revision);
        const current = await this.expireExport(tx, record);
        if (current.status === "ready" || current.status === "expired") return exportSummary(current);
        if (current.attempts >= this.policy.maxExportAttempts) throw error("ACCOUNT_EXPORT_RETRIES_EXHAUSTED", "本次导出重试已达上限，请新建请求。", 409, "request_new_export");
        collectionStarted = true;
        const actor = toActor(tx.context.user);
        const bundle = this.validateBundle(await this.deps.ownData.collectOwnData(actor, tx.executor,
          { maxRecords: this.policy.maxExportRecords, maxBytes: this.policy.maxExportBytes }), actor.userId);
        await this.deps.ownData.assertProjectAccess(actor, bundle.projects.map((p) => p.projectId), tx.executor);
        await tx.assertSession();
        const document: OwnDataDocument = { schemaVersion: 1, userId: actor.userId, generatedAt: tx.now(), profile: toProfile(tx.context.user), ...bundle };
        const byteLength = Buffer.byteLength(JSON.stringify(document), "utf8");
        if (byteLength > this.policy.maxExportBytes) throw error("ACCOUNT_EXPORT_TOO_LARGE", "数据超出单次导出大小，请联系支持分批处理。", 422);
        const value: StoredDataExport = { ...current, status: "ready", updatedAt: tx.now(), revision: current.revision + 1,
          attempts: current.attempts + 1, errorCode: null, byteLength, document };
        // The original request deadline is fixed; generation/retries do not extend access indefinitely.
        if (Date.parse(value.expiresAt) <= Date.parse(tx.now())) return exportSummary(await this.expireExport(tx, current));
        await tx.saveExport(value); await tx.audit("data_export_prepared", "data_export", id, "ready");
        return exportSummary(value);
      });
    } catch (failure) {
      if (!collectionStarted) throw failure;
      // A failed SQL collection may abort its transaction. Persist recovery state in a new transaction.
      return this.deps.store.withSession(hash, async (tx) => {
        const record = await tx.getExport(id);
        if (!record) throw error("ACCOUNT_EXPORT_NOT_FOUND", "导出请求不可见或不存在。", 404);
        if (record.revision !== expectedRevision) throw revisionConflict(record.revision);
        if (Date.parse(record.expiresAt) <= Date.parse(tx.now())) return exportSummary(await this.expireExport(tx, record));
        const code = failure instanceof DomainError && ["ACCOUNT_EXPORT_TOO_LARGE", "ACCOUNT_EXPORT_SCOPE_INVALID", "ACCOUNT_EXPORT_UNSAFE_DATA"].includes(failure.code)
          ? failure.code : "ACCOUNT_EXPORT_COLLECTION_FAILED";
        const value: StoredDataExport = { ...record, status: "failed", updatedAt: tx.now(), revision: record.revision + 1,
          attempts: record.attempts + 1, errorCode: code, byteLength: null, document: null };
        await tx.assertSession(); await tx.saveExport(value); await tx.audit("data_export_prepared", "data_export", id, "failed");
        return exportSummary(value);
      });
    }
  }

  async downloadExport(token: string | null | undefined, id: string): Promise<{ readonly filename: string; readonly json: string }> {
    this.id(id);
    const result = await this.deps.store.withSession(this.tokenHash(token), async (tx) => {
      const item = await tx.getExport(id);
      if (!item) throw error("ACCOUNT_EXPORT_NOT_FOUND", "导出请求不可见或不存在。", 404);
      const record = await this.expireExport(tx, item);
      if (record.status !== "ready" || !record.document) return null;
      const actor = toActor(tx.context.user);
      await this.deps.ownData.assertProjectAccess(actor, record.document.projects.map((p) => p.projectId), tx.executor);
      await tx.assertSession();
      if (Date.parse(record.expiresAt) <= Date.parse(tx.now())) { await this.expireExport(tx, record); return null; }
      const safeBundle = this.validateBundle(record.document, actor.userId);
      const profile = record.document.profile;
      if (profile.id !== actor.userId) throw error("ACCOUNT_EXPORT_SCOPE_INVALID", "导出资料主体不符合本人范围。", 422);
      const document: OwnDataDocument = { ...safeBundle, schemaVersion: 1, userId: actor.userId, generatedAt: record.document.generatedAt,
        profile: { id: profile.id, email: profile.email, displayName: profile.displayName, timezone: profile.timezone,
          emailVerifiedAt: profile.emailVerifiedAt, revision: profile.revision } };
      const json = JSON.stringify(document);
      if (Buffer.byteLength(json, "utf8") > this.policy.maxExportBytes) throw error("ACCOUNT_EXPORT_TOO_LARGE", "导出文件超出大小限制。", 422);
      await tx.audit("data_export_downloaded", "data_export", id, "succeeded");
      // The filename uses server time, never arbitrary client supplied paths or IDs.
      return { filename: `hackathon-own-data-${record.createdAt.slice(0, 10)}.json`, json };
    });
    if (!result) throw error("ACCOUNT_EXPORT_UNAVAILABLE", "导出文件尚未生成或已过期，请生成或新建请求。", 409, "request_new_export");
    return result;
  }

  async requestDeletion(token: string | null | undefined): Promise<AccountDeletionSummary> {
    return this.deps.store.withSession(this.tokenHash(token), async (tx) => {
      this.requireRecent(tx);
      const impact = this.validateImpact(await this.deps.deletionImpact.inspectOwnDeletion(toActor(tx.context.user), tx.executor));
      await tx.assertSession(); this.requireRecent(tx);
      const current = await tx.getDeletion();
      if (current && current.status !== "cancelled") return deletionSummary(current);
      const now = tx.now();
      const request: AccountDeletionRequest = { id: this.deps.ids.next(), userId: tx.context.user.id,
        status: impact.lastManagerProjects.length ? "blocked" : "pending", createdAt: now, updatedAt: now, revision: 1, impact };
      await tx.saveDeletion(request); await tx.audit("account_deletion_requested", "deletion_request", request.id, request.status);
      return deletionSummary(request);
    });
  }

  async refreshDeletion(token: string | null | undefined, id: string, expectedRevision: number): Promise<AccountDeletionSummary> {
    this.id(id); this.revision(expectedRevision);
    return this.deps.store.withSession(this.tokenHash(token), async (tx) => {
      const record = await this.requireDeletion(tx, id, expectedRevision);
      if (record.status === "cancelled" || record.status === "processing") return deletionSummary(record);
      const impact = this.validateImpact(await this.deps.deletionImpact.inspectOwnDeletion(toActor(tx.context.user), tx.executor));
      await tx.assertSession();
      const value: AccountDeletionRequest = { ...record, impact, status: impact.lastManagerProjects.length ? "blocked" : "pending", updatedAt: tx.now(), revision: record.revision + 1 };
      await tx.saveDeletion(value); await tx.audit("account_deletion_reviewed", "deletion_request", id, value.status);
      return deletionSummary(value);
    });
  }

  async cancelDeletion(token: string | null | undefined, id: string, expectedRevision: number): Promise<AccountDeletionSummary> {
    this.id(id); this.revision(expectedRevision);
    return this.deps.store.withSession(this.tokenHash(token), async (tx) => {
      const record = await this.requireDeletion(tx, id, expectedRevision);
      if (record.status === "cancelled") return deletionSummary(record);
      if (record.status === "processing") throw error("ACCOUNT_DELETION_PROCESSING", "删除已进入处理，无法在此取消，请联系支持。", 409);
      const value: AccountDeletionRequest = { ...record, status: "cancelled", revision: record.revision + 1, updatedAt: tx.now() };
      await tx.assertSession(); await tx.saveDeletion(value); await tx.audit("account_deletion_cancelled", "deletion_request", id, "cancelled");
      return deletionSummary(value);
    });
  }

  /** Trusted root worker only. A processing receipt is never a claim of completed physical deletion. */
  async beginDeletionProcessing(userId: string, id: string, expectedRevision: number): Promise<AccountDeletionSummary> {
    this.id(userId); this.id(id); this.revision(expectedRevision);
    return this.deps.store.withUser(userId, async (tx) => {
      const record = await this.requireDeletion(tx, id, expectedRevision);
      if (!["pending", "blocked"].includes(record.status)) throw error("ACCOUNT_DELETION_STATE_INVALID", "该申请不能进入删除处理。", 409);
      const impact = this.validateImpact(await this.deps.deletionImpact.inspectOwnDeletion(toActor(tx.context.user), tx.executor));
      await tx.assertSession();
      const value: AccountDeletionRequest = { ...record, impact, status: impact.lastManagerProjects.length ? "blocked" : "processing", revision: record.revision + 1, updatedAt: tx.now() };
      await tx.saveDeletion(value);
      if (value.status === "processing") await tx.beginDeletionProcessing();
      await tx.audit("account_deletion_processing", "deletion_request", id, value.status);
      return deletionSummary(value);
    });
  }

  async requestEmailChange(token: string | null | undefined, input: { readonly newEmail: unknown; readonly expectedRevision: number }, trustedClientKey: string): Promise<EmailChangeReceipt> {
    const newEmail = normalizeLoginEmail(input.newEmail); this.revision(input.expectedRevision); this.clientKey(trustedClientKey);
    const hash = this.tokenHash(token), id = this.deps.ids.next();
    const currentCode = this.deps.crypto.generateCode(), newCode = this.deps.crypto.generateCode();
    const reserved = await this.deps.store.withSession(hash, async (tx) => {
      this.requireRecent(tx);
      if (tx.context.user.revision !== input.expectedRevision) throw revisionConflict(tx.context.user.revision);
      if (newEmail === tx.context.user.email) throw error("ACCOUNT_EMAIL_UNCHANGED", "新邮箱与当前邮箱相同。", 422);
      const rule = (purpose: string, key: string, maximum: number, cooldownMs = 0) => ({ key: this.deps.crypto.hashRateKey(purpose, key), windowMs: this.policy.rateWindowMs, maximum, cooldownMs });
      if (!await tx.takeRates([rule("email-change-send-user", tx.context.user.id, this.policy.maxSendsPerUser, this.policy.sendCooldownMs),
        rule("email-change-send-email", newEmail, this.policy.maxSendsPerEmail, this.policy.sendCooldownMs),
        rule("email-change-send-client", trustedClientKey, this.policy.maxSendsPerClient)])) throw error("AUTH_RATE_LIMITED", "邮箱验证请求过于频繁，请稍后重试。", 429, "wait_and_retry");
      await tx.assertSession(); this.requireRecent(tx);
      const now = tx.now(), expiresAt = new Date(Date.parse(now) + this.policy.challengeLifetimeMs).toISOString();
      await tx.revokeEmailChallenges();
      await tx.saveEmailChallenge({ id, userId: tx.context.user.id, oldEmail: tx.context.user.email, newEmail, expectedRevision: input.expectedRevision,
        currentCodeHash: this.deps.crypto.hashCode(`${id}:current-email`, currentCode), newCodeHash: this.deps.crypto.hashCode(`${id}:new-email`, newCode),
        createdAt: now, expiresAt, delivery: "pending", failedAttempts: 0, consumedAt: null, revokedAt: null });
      await tx.audit("email_change_requested", "email_change", id, "pending");
      return { oldEmail: tx.context.user.email, expiresAt };
    }, [newEmail]);
    try {
      await this.deps.email.sendEmailChangeCode({ email: reserved.oldEmail, code: currentCode, expiresAt: reserved.expiresAt, purpose: "current_email" });
      await this.deps.email.sendEmailChangeCode({ email: newEmail, code: newCode, expiresAt: reserved.expiresAt, purpose: "new_email" });
    } catch {
      await this.deps.store.withSession(hash, async (tx) => {
        const challenge = await tx.getEmailChallenge(id);
        if (challenge && !challenge.consumedAt && !challenge.revokedAt) await tx.saveEmailChallenge({ ...challenge, delivery: "unknown" });
        await tx.audit("email_change_delivery", "email_change", id, "unknown");
      });
      throw error("AUTH_EMAIL_UNAVAILABLE", "邮件未确认受理，本次验证不可用。请稍后明确重新获取。", 503, "request_new_code");
    }
    await this.deps.store.withSession(hash, async (tx) => {
      const challenge = await tx.getEmailChallenge(id);
      if (!challenge || challenge.delivery !== "pending" || challenge.consumedAt || challenge.revokedAt || Date.parse(challenge.expiresAt) <= Date.parse(tx.now())) {
        throw error("AUTH_CHALLENGE_UNAVAILABLE", "本次邮箱验证已失效，请重新获取。", 409, "request_new_code");
      }
      await tx.assertSession(); await tx.saveEmailChallenge({ ...challenge, delivery: "ready" });
      await tx.audit("email_change_delivery", "email_change", id, "ready");
    });
    return { challengeId: id, expiresAt: reserved.expiresAt, resendAfterSeconds: Math.ceil(this.policy.sendCooldownMs / 1000), message: "验证邮件已受理，请分别输入当前邮箱和新邮箱中的验证码。" };
  }

  async verifyEmailChange(token: string | null | undefined, input: { readonly challengeId: string; readonly currentCode: unknown; readonly newCode: unknown }, trustedClientKey: string): Promise<EmailChangeResult> {
    this.id(input.challengeId); this.clientKey(trustedClientKey); const hash = this.tokenHash(token);
    const hint = await this.deps.store.withSession(hash, (tx) => tx.getEmailChallenge(input.challengeId));
    // Non-owner IDs reveal no email and are never used to choose mailbox locks.
    const result = await this.deps.store.withSession(hash, async (tx) => {
      if (!await tx.takeRates([
        { key: this.deps.crypto.hashRateKey("email-change-verify-user", tx.context.user.id), windowMs: this.policy.rateWindowMs, maximum: this.policy.maxVerificationsPerUser },
        { key: this.deps.crypto.hashRateKey("email-change-verify-client", trustedClientKey), windowMs: this.policy.rateWindowMs, maximum: this.policy.maxVerificationsPerClient },
      ])) return { status: "rate_limited" } as const;
      const value = await tx.getEmailChallenge(input.challengeId);
      if (!value || value.delivery !== "ready" || value.consumedAt || value.revokedAt || value.oldEmail !== tx.context.user.email
        || Date.parse(value.expiresAt) <= Date.parse(tx.now()) || value.failedAttempts >= this.policy.maxCodeFailures) return { status: "invalid" } as const;
      const code = (v: unknown) => typeof v === "string" && /^[0-9]{8}$/.test(v) ? v : "invalid-code-format";
      const expectedCurrent = this.deps.crypto.hashCode(`${value.id}:current-email`, code(input.currentCode));
      const expectedNew = this.deps.crypto.hashCode(`${value.id}:new-email`, code(input.newCode));
      // Store hashes are HMACs, not raw low-entropy codes. Comparison is constant-time in Node.
      const currentMatches = constantHashEqual(value.currentCodeHash, expectedCurrent);
      const newMatches = constantHashEqual(value.newCodeHash, expectedNew);
      if (!currentMatches || !newMatches) {
        await tx.saveEmailChallenge({ ...value, failedAttempts: value.failedAttempts + 1 });
        await tx.audit("email_change_verified", "email_change", value.id, "denied");
        return { status: "invalid" } as const;
      }
      await tx.assertSession();
      if (Date.parse(value.expiresAt) <= Date.parse(tx.now())) return { status: "invalid" } as const;
      if (value.expectedRevision !== tx.context.user.revision) return { status: "version_conflict", revision: tx.context.user.revision } as const;
      const updated = await tx.changeEmail(value.newEmail, value.expectedRevision);
      if (updated === "version_conflict") return { status: "version_conflict", revision: tx.context.user.revision } as const;
      if (updated === "email_conflict") return { status: "email_conflict" } as const;
      await tx.saveEmailChallenge({ ...value, consumedAt: tx.now() });
      await tx.revokeEmailChallenges();
      await tx.audit("email_change_verified", "email_change", value.id, "succeeded");
      return { status: "changed", profile: toProfile(updated) } as const;
    }, hint ? [hint.newEmail] : []);
    if (result.status === "rate_limited") throw error("AUTH_RATE_LIMITED", "验证请求过于频繁，请稍后再试。", 429, "wait_and_retry");
    if (result.status === "version_conflict") throw revisionConflict(result.revision);
    if (result.status === "email_conflict") throw error("ACCOUNT_EMAIL_CONFLICT", "该邮箱无法用于本次更换，请使用其他邮箱。", 409, "choose_other_email");
    if (result.status !== "changed") throw error("AUTH_CHALLENGE_INVALID", "验证码无效、已使用或已过期，请重新获取。", 401, "request_new_code");
    return { changed: true, requiresLogin: true, profile: result.profile };
  }

  private async expireExport(tx: AccountTransaction, record: StoredDataExport): Promise<StoredDataExport> {
    if (record.status === "expired" || Date.parse(record.expiresAt) > Date.parse(tx.now())) return record;
    const expired: StoredDataExport = { ...record, status: "expired", document: null, byteLength: null, revision: record.revision + 1, updatedAt: tx.now() };
    await tx.saveExport(expired); return expired;
  }
  private async requireDeletion(tx: AccountTransaction, id: string, revision: number): Promise<AccountDeletionRequest> {
    const record = await tx.getDeletion(id);
    if (!record) throw error("ACCOUNT_DELETION_NOT_FOUND", "删除申请不可见或不存在。", 404);
    if (record.revision !== revision) throw revisionConflict(record.revision);
    return record;
  }
  private validateImpact(value: DeletionImpact): DeletionImpact {
    if (!value || !Array.isArray(value.lastManagerProjects) || !Array.isArray(value.notices)
      || value.lastManagerProjects.length > 500 || value.notices.length > 20) throw new Error("Invalid deletion impact projection.");
    return { lastManagerProjects: value.lastManagerProjects.map((p) => {
      this.id(p.projectId);
      if (typeof p.name !== "string" || p.name.length > 200 || p.remediationUrl !== `/app/projects/${p.projectId}/team`) throw new Error("Invalid deletion remediation.");
      return { projectId: p.projectId, name: p.name, remediationUrl: p.remediationUrl };
    }), notices: value.notices.map((n) => {
      if (typeof n !== "string" || n.length > 1000) throw new Error("Invalid deletion notice."); return n;
    }) };
  }
  private validateBundle(bundle: OwnDataBundle, userId: string): OwnDataBundle {
    const categories = ["personal", "conversations", "generations", "assessments", "retrospectives", "bookmarks"] as const;
    if (!bundle || !bundle.records || !Array.isArray(bundle.projects)) throw error("ACCOUNT_EXPORT_SCOPE_INVALID", "无法确认导出资料范围。", 422);
    let count = bundle.projects.length;
    const records = Object.fromEntries(categories.map((category) => {
      const items = bundle.records[category];
      if (!Array.isArray(items)) throw error("ACCOUNT_EXPORT_SCOPE_INVALID", "无法确认导出资料范围。", 422);
      count += items.length;
      return [category, items.map((item) => {
        if (item.userId !== userId || typeof item.id !== "string" || !item.id || item.id.length > 200) throw error("ACCOUNT_EXPORT_SCOPE_INVALID", "导出资料主体不符合本人范围。", 422);
        validateJsonData(item.data);
        return { id: item.id, userId, data: item.data };
      })];
    })) as unknown as OwnDataBundle["records"];
    if (count > this.policy.maxExportRecords) throw error("ACCOUNT_EXPORT_TOO_LARGE", "数据超出单次导出数量，请联系支持分批处理。", 422);
    const projects = bundle.projects.map((p) => {
      this.id(p.projectId);
      if (typeof p.name !== "string" || p.name.length > 200 || typeof p.summary !== "string" || p.summary.length > 5000) throw error("ACCOUNT_EXPORT_SCOPE_INVALID", "项目导出摘要无效。", 422);
      return { projectId: p.projectId, name: p.name, summary: p.summary };
    });
    return { records, projects };
  }
  private tokenHash(token: string | null | undefined): string {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw error("AUTH_SESSION_REQUIRED", "登录已失效，请重新登录。", 401, "login");
    return this.deps.crypto.hashSessionToken(token);
  }
  private requireRecent(tx: AccountTransaction): void {
    if (Date.parse(tx.context.session.authenticatedAt) < Date.parse(tx.now()) - this.policy.recentAuthenticationMs) throw error("AUTH_REAUTHENTICATION_REQUIRED", "操作前请重新验证当前邮箱并登录。", 403, "reauthenticate");
  }
  private id(value: string): void { if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw error("ACCOUNT_ID_INVALID", "请选择有效的账号操作记录。", 422); }
  private revision(value: number): void { if (!Number.isSafeInteger(value) || value < 1) throw error("AUTH_REVISION_INVALID", "请携带当前版本后再操作。", 422); }
  private clientKey(value: string): void { if (typeof value !== "string" || !value || value.length > 512) throw new Error("A trusted client key is required."); }
}

function constantHashEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex"), right = Buffer.from(b, "hex");
  return left.length === 32 && right.length === 32 && timingSafeEqual(left, right);
}
/** The root port still must select safe columns; this guard rejects accidental credential projections. */
function validateJsonData(value: unknown, depth = 0): void {
  if (depth > 32) throw error("ACCOUNT_EXPORT_UNSAFE_DATA", "资料嵌套超出导出限制。", 422);
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
  if (Array.isArray(value)) { for (const v of value) validateJsonData(v, depth + 1); return; }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw error("ACCOUNT_EXPORT_UNSAFE_DATA", "资料格式不适用于导出。", 422);
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:password|secret|credentials?|access[_-]?token|refresh[_-]?token|session[_-]?token|token[_-]?hash|code[_-]?hash|verification[_-]?code|otp|api[_-]?key|pepper|authorization)$/i.test(key)) throw error("ACCOUNT_EXPORT_UNSAFE_DATA", "导出资料包含不应交付的安全字段。", 422);
    validateJsonData(item, depth + 1);
  }
}
