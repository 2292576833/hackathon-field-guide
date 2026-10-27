import type { Actor, Clock, IdGenerator, ProjectAccessPort } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type {
  ConfirmedRequirementsPort, DeliveryCapabilityPort, DeliveryStorePort,
  DeliveryVerification, SubmissionRecord,
} from "./types.ts";

export interface DeliveryServiceDependencies {
  access: ProjectAccessPort;
  capabilities: DeliveryCapabilityPort;
  store: DeliveryStorePort;
  requirements: ConfirmedRequirementsPort;
  clock: Clock;
  ids: IdGenerator;
}

export interface RecordVerificationInput {
  repositoryCommitSha?: string | null;
  verifiedAt: string;
  environmentSummary: string;
  steps: string[];
  outcome: DeliveryVerification["outcome"];
  blockers: string[];
  evidenceRefs: string[];
  verificationSource?: "user_reported";
}

/** Full replacement of the editable submission fields. Actor, ID and version are server-owned. */
export interface RecordSubmissionInput {
  eventId: string;
  stageId: string;
  requirementsVersion: string;
  platformUrl: string;
  submittedAt?: string | null;
  repositoryCommitSha?: string | null;
  status: "not_submitted" | "reported" | "rejected_or_withdrawn";
  evidenceRefs: string[];
  verificationSource?: "user_reported";
}

function invalid(message: string): never {
  throw new DomainError("INVALID_DELIVERY_INPUT", message);
}

function objectWithKeys(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("交付记录必须为对象。");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !allowed.includes(key))) invalid("包含不可写入的交付字段。");
  return input;
}

function text(value: unknown, field: string, max = 2000, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    invalid(`${field}格式不正确。`);
  }
  const result = value.trim();
  if (!allowEmpty && result.length === 0) invalid(`${field}不能为空。`);
  return result;
}

function strings(value: unknown, field: string, maxItems = 100): string[] {
  if (!Array.isArray(value) || value.length > maxItems) invalid(`${field}必须为有效列表。`);
  return value.map((item) => text(item, field));
}

function httpsUrl(value: unknown): string {
  const original = text(value, "提交入口", 2048);
  let url: URL;
  try { url = new URL(original); } catch { invalid("提交入口必须为 HTTPS 地址。"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
    invalid("提交入口必须为不含账号凭据的 HTTPS 地址。");
  }
  return url.href;
}

function commitSha(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(value)) invalid("代码版本必须为完整 commit SHA。");
  return value.toLowerCase();
}

function instant(value: unknown, field: string, now: Date): string {
  // Require an explicit offset: interpreting a local date through the server timezone is unsafe.
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) {
    invalid(`${field}必须为带时区的日期时间。`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.getTime() > now.getTime()) invalid(`${field}无效或晚于当前时间。`);
  // Date.parse silently normalizes invalid month-days; validate the local calendar separately.
  const datePart = value.slice(0, 10);
  const calendar = new Date(`${datePart}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== datePart) invalid(`${field}日期无效。`);
  return parsed.toISOString();
}

function serverTime(clock: Clock): Date {
  const now = clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new DomainError("INVALID_SERVER_CLOCK", "暂时无法确定记录时间。", { status: 500 });
  }
  return now;
}

function normalizeVerification(input: RecordVerificationInput, now: Date): Omit<DeliveryVerification, "id" | "projectId" | "verifierId" | "version"> {
  const value = objectWithKeys(input, ["repositoryCommitSha", "verifiedAt", "environmentSummary", "steps", "outcome", "blockers", "evidenceRefs", "verificationSource"]);
  if (value.verificationSource !== undefined && value.verificationSource !== "user_reported") invalid("首版只支持用户自报验收。");
  if (!["passed", "failed", "inconclusive"].includes(value.outcome as string)) invalid("验收结论无效。");
  const outcome = value.outcome as DeliveryVerification["outcome"];
  const environmentSummary = text(value.environmentSummary, "验收环境", 2000, true);
  const steps = strings(value.steps, "验收步骤");
  const blockers = strings(value.blockers, "阻塞项");
  const evidenceRefs = strings(value.evidenceRefs, "验收证据");
  if (outcome === "passed" && (!environmentSummary || !steps.length || !evidenceRefs.length || blockers.length)) {
    invalid("通过验收必须有环境、步骤与证据，且没有未解决的阻塞项。");
  }
  return {
    repositoryCommitSha: commitSha(value.repositoryCommitSha),
    verifiedAt: instant(value.verifiedAt, "验收时间", now),
    environmentSummary, steps, outcome, blockers, evidenceRefs, verificationSource: "user_reported",
  };
}

function normalizeSubmission(input: RecordSubmissionInput, now: Date): Omit<SubmissionRecord, "id" | "projectId" | "recordedBy" | "recordedAt" | "version"> {
  const value = objectWithKeys(input, ["eventId", "stageId", "requirementsVersion", "platformUrl", "submittedAt", "repositoryCommitSha", "status", "evidenceRefs", "verificationSource"]);
  if (value.verificationSource !== undefined && value.verificationSource !== "user_reported") invalid("首版只支持用户自报提交。");
  if (!["not_submitted", "reported", "rejected_or_withdrawn"].includes(value.status as string)) invalid("提交状态无效；平台确认尚未接入。");
  const status = value.status as RecordSubmissionInput["status"];
  const submittedAt = value.submittedAt === undefined || value.submittedAt === null ? null : instant(value.submittedAt, "提交时间", now);
  const evidenceRefs = strings(value.evidenceRefs, "提交证据");
  if (status === "reported" && (submittedAt === null || !evidenceRefs.length)) invalid("标记已提交必须有真实提交时间与证据。");
  if (status === "not_submitted" && submittedAt !== null) invalid("未提交记录不能包含提交时间。");
  return {
    eventId: text(value.eventId, "赛事", 200), stageId: text(value.stageId, "赛事阶段", 200),
    requirementsVersion: text(value.requirementsVersion, "规则版本", 200), platformUrl: httpsUrl(value.platformUrl),
    submittedAt, repositoryCommitSha: commitSha(value.repositoryCommitSha), status, evidenceRefs,
    verificationSource: "user_reported",
  };
}

export class DeliveryService {
  private readonly dependencies: DeliveryServiceDependencies;

  constructor(dependencies: DeliveryServiceDependencies) { this.dependencies = dependencies; }

  private async assertAccess(actor: Actor, projectId: string, capability?: "verifyDelivery" | "recordSubmission"): Promise<void> {
    if (!actor || typeof actor.userId !== "string" || !actor.userId.trim()) {
      throw new DomainError("AUTHENTICATION_REQUIRED", "请先登录。", { status: 401 });
    }
    text(projectId, "项目", 200);
    const membership = await this.dependencies.access.getMembership(projectId, actor.userId);
    if (!membership || membership.status !== "active" || membership.projectId !== projectId || membership.userId !== actor.userId) {
      throw new DomainError("PROJECT_ACCESS_DENIED", "你当前不能访问该项目的交付记录。", { status: 403 });
    }
    if (capability) {
      const capabilities = await this.dependencies.capabilities.getCapabilities(projectId, actor.userId);
      if (capabilities[capability] !== true) {
        throw new DomainError("DELIVERY_CAPABILITY_DENIED", "你当前没有此项目的交付记录权限。", { status: 403 });
      }
    }
  }

  async recordVerification(actor: Actor, projectId: string, input: RecordVerificationInput): Promise<DeliveryVerification> {
    await this.assertAccess(actor, projectId, "verifyDelivery");
    const normalized = normalizeVerification(input, serverTime(this.dependencies.clock));
    const record: DeliveryVerification = { ...normalized, id: this.dependencies.ids.next(), projectId, verifierId: actor.userId, version: 1 };
    await this.dependencies.store.insertVerification(record);
    return structuredClone(record);
  }

  async listVerifications(actor: Actor, projectId: string): Promise<DeliveryVerification[]> {
    await this.assertAccess(actor, projectId);
    return structuredClone(await this.dependencies.store.listVerifications(projectId));
  }

  private async assertRequirements(projectId: string, record: Pick<SubmissionRecord, "eventId" | "stageId" | "requirementsVersion" | "platformUrl">): Promise<void> {
    await this.dependencies.requirements.assertConfirmed({ projectId, eventId: record.eventId, stageId: record.stageId, requirementsVersion: record.requirementsVersion, platformUrl: record.platformUrl });
  }

  async recordSubmission(actor: Actor, projectId: string, input: RecordSubmissionInput): Promise<SubmissionRecord> {
    await this.assertAccess(actor, projectId, "recordSubmission");
    const now = serverTime(this.dependencies.clock);
    const normalized = normalizeSubmission(input, now);
    await this.assertRequirements(projectId, normalized);
    const record: SubmissionRecord = { ...normalized, id: this.dependencies.ids.next(), projectId, recordedBy: actor.userId, recordedAt: now.toISOString(), version: 1 };
    await this.dependencies.store.insertSubmission(record);
    return structuredClone(record);
  }

  async updateSubmission(actor: Actor, projectId: string, id: string, expectedVersion: number, input: RecordSubmissionInput): Promise<SubmissionRecord> {
    await this.assertAccess(actor, projectId, "recordSubmission");
    text(id, "提交记录", 200);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) invalid("预期版本必须为正整数。");
    const previous = await this.dependencies.store.getSubmission(projectId, id);
    if (!previous || previous.projectId !== projectId || previous.id !== id) {
      throw new DomainError("SUBMISSION_NOT_FOUND", "找不到该项目的提交记录。", { status: 404 });
    }
    if (previous.verificationSource === "platform_verified") throw new DomainError("VERIFIED_RECEIPT_IMMUTABLE", "主办方确认的收件回执由赛事流程维护。需要更新材料时，请回到对应比赛重新提交。", { status: 409 });
    if (previous.version !== expectedVersion) {
      throw new DomainError("VERSION_CONFLICT", "提交记录已更新，请查看最新版本。", { status: 409, latestRevision: previous.version });
    }
    const now = serverTime(this.dependencies.clock);
    const normalized = normalizeSubmission(input, now);
    if (normalized.eventId !== previous.eventId || normalized.stageId !== previous.stageId) invalid("同一提交记录不能改为另一个赛事阶段，请新增记录。");
    await this.assertRequirements(projectId, normalized);
    const record: SubmissionRecord = { ...normalized, id, projectId, recordedBy: actor.userId, recordedAt: now.toISOString(), version: expectedVersion + 1 };
    await this.dependencies.store.updateSubmission(record, expectedVersion);
    return structuredClone(record);
  }

  /** Includes every immutable version; consumers must use the largest version per ID for current status. */
  async listSubmissions(actor: Actor, projectId: string): Promise<SubmissionRecord[]> {
    await this.assertAccess(actor, projectId);
    return structuredClone(await this.dependencies.store.listSubmissions(projectId));
  }
}
