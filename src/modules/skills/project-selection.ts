import type { Actor, Clock, ProjectAccessPort, ProjectMembershipAccess } from "../../shared/contracts.ts";
import { DomainError, isDomainError } from "../../shared/errors.ts";
import { AGENT_IDS, assertVersion, hash } from "./domain.ts";
import type { AgentId, Skill, SkillVersion, TrackBundle } from "./domain.ts";
import type { SkillsRepository, SkillsTransaction } from "./ports.ts";
import type { SkillCompatibilityEvidence } from "./publication-types.ts";

/** `version` is the explicit skillVersion or bundleVersion, never `latest`. */
export interface FixedSkillReference {
  kind: "skill" | "bundle";
  id: string;
  version: string;
  versionId: string;
  contentHash: string;
  revision: number;
}
/** Unknown client versions/systems are omitted; selection does not assert compatibility. */
export interface SkillUseEnvironment { agentId?: AgentId; clientVersion?: string; os?: string }
/** Optional M05 DTO. learningMinutes is part of the existing task estimate, not extra capacity. */
export interface TaskSkillReference {
  reference: FixedSkillReference;
  purpose: string;
  learningMinutes: number;
  environment: SkillUseEnvironment;
}
export interface ReviewedSkillOption {
  reference: FixedSkillReference;
  title: string;
  summary: string;
  prerequisites: readonly string[];
  compatibility: readonly SkillCompatibilityEvidence[];
  requiredSkillVersions: readonly FixedSkillReference[];
  optionalSkillVersionIds: readonly string[];
  limitations: readonly string[];
}
export interface ReviewedSkillLookupPort {
  list(): Promise<readonly ReviewedSkillOption[]>;
  /** Throws when unpublished, withdrawn, malformed, changed, or a required bundle member is unavailable. */
  get(reference: FixedSkillReference): Promise<ReviewedSkillOption>;
}
export interface ProjectSkillSelectionState {
  projectId: string;
  revision: number;
  selections: readonly TaskSkillReference[];
  updatedBy: string;
  updatedAt: string;
}
export interface ProjectSkillSelectionTransaction {
  getProject(projectId: string, lock?: boolean): Promise<{ id: string; archived: boolean; readOnly: boolean } | null>;
  get(projectId: string, lock?: boolean): Promise<ProjectSkillSelectionState | null>;
  /** Atomic CAS (0 means no row). Preserve revision tombstones when selections become empty. */
  save(state: ProjectSkillSelectionState, expectedRevision: number): Promise<void>;
}
/**
 * M02/root owns persistence. Bind this port, access and lookup to the same executor.
 * The root adapter must keep current session/membership checks and write guards atomic,
 * holding membership/project locks until commit; it must not compose independent connections.
 */
export interface ProjectSkillSelectionPort {
  transaction<T>(work: (transaction: ProjectSkillSelectionTransaction) => Promise<T>): Promise<T>;
}
export interface ProjectSkillSelectionDependencies {
  selections: ProjectSkillSelectionPort;
  projectAccess: ProjectAccessPort;
  reviewedSkills: ReviewedSkillLookupPort;
  clock: Clock;
}
export interface ProjectSkillSelectionView {
  projectId: string;
  revision: number;
  selections: readonly TaskSkillReference[];
  availability: readonly { reference: FixedSkillReference; available: boolean; reason: string | null }[];
  updatedBy: string | null;
  updatedAt: string | null;
  canManage: boolean;
  readOnly: boolean;
}

const MAX_REFERENCES = 12;
/** Optional M05 model/output schema. Root adds this field without adding it to required. */
export const TASK_SKILL_REFS_JSON_SCHEMA = {
  type: "array", maxItems: MAX_REFERENCES,
  items: {
    type: "object", additionalProperties: false, required: ["reference", "purpose", "learningMinutes", "environment"],
    properties: {
      reference: {
        type: "object", additionalProperties: false, required: ["kind", "id", "version", "versionId", "contentHash", "revision"],
        properties: {
          kind: { type: "string", enum: ["skill", "bundle"] },
          id: { type: "string", minLength: 1, maxLength: 240, pattern: "^[a-zA-Z0-9_.@+-]+$" },
          version: { type: "string", minLength: 1, maxLength: 240, pattern: "^[a-zA-Z0-9_.@+-]+$" },
          versionId: { type: "string", minLength: 1, maxLength: 240, pattern: "^[a-zA-Z0-9_.@+-]+$" },
          contentHash: { type: "string", pattern: "^[a-f0-9]{64}$" }, revision: { type: "integer", minimum: 1 },
        },
      },
      purpose: { type: "string", minLength: 1, maxLength: 500 },
      learningMinutes: { type: "integer", minimum: 0, maximum: 10080 },
      environment: {
        type: "object", additionalProperties: false,
        properties: { agentId: { type: "string", enum: AGENT_IDS }, clientVersion: { type: "string", minLength: 1, maxLength: 80 }, os: { type: "string", minLength: 1, maxLength: 80 } },
      },
    },
  },
} as const;
function invalid(message = "技能引用字段不完整或格式不正确。"): never { throw new DomainError("INVALID_SKILL_REFERENCE", message); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !keys.includes(key))) invalid("技能引用不能包含额外字段、本机路径或凭据。");
  return record;
}
function safeText(value: unknown, max: number, optional = false): string | undefined {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) invalid("请输入适当长度的文字。");
  const result = value.trim();
  if (/(?:[a-z]:[\\/]|\\\\[^\s\\]+\\|\/(?:Users|home|root|var|tmp)\/|\b(?:sk-|ghp_|github_pat_)[a-z0-9_-]{8,}|\bBearer\s+\S+|(?:api[_ -]?key|password|secret|token|密钥|口令)\s*[:=]\s*\S+)/i.test(result)) invalid("项目技能资料中不能保存本机绝对路径或密钥。");
  return result;
}
function identity(value: unknown): string {
  const result = safeText(value, 240)!;
  if (!/^[a-zA-Z0-9_.@+-]+$/.test(result) || result === "latest") invalid("请选择目录中的明确固定版本。");
  return result;
}
function revision(value: unknown, zero = false): number {
  if (!Number.isSafeInteger(value) || (value as number) < (zero ? 0 : 1)) invalid("版本号无效。");
  return value as number;
}
export function parseFixedSkillReference(value: unknown): FixedSkillReference {
  const input = object(value, ["kind", "id", "version", "versionId", "contentHash", "revision"]);
  if (input.kind !== "skill" && input.kind !== "bundle") invalid();
  if (typeof input.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(input.contentHash)) invalid("固定内容哈希无效。");
  return { kind: input.kind, id: identity(input.id), version: identity(input.version), versionId: identity(input.versionId), contentHash: input.contentHash, revision: revision(input.revision) };
}
export function parseSkillUseEnvironment(value: unknown): SkillUseEnvironment {
  const input = object(value, ["agentId", "clientVersion", "os"]);
  if (input.agentId !== undefined && !AGENT_IDS.includes(input.agentId as AgentId)) invalid("AI 工具不在受控目录中。");
  const clientVersion = safeText(input.clientVersion, 80, true);
  const os = safeText(input.os, 80, true);
  return { ...(input.agentId !== undefined ? { agentId: input.agentId as AgentId } : {}), ...(clientVersion ? { clientVersion } : {}), ...(os ? { os } : {}) };
}
export function parseTaskSkillReferences(value: unknown): readonly TaskSkillReference[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_REFERENCES) invalid(`每个任务最多选择 ${MAX_REFERENCES} 项技能或技能包。`);
  const seen = new Set<string>();
  return value.map(item => {
    const input = object(item, ["reference", "purpose", "learningMinutes", "environment"]);
    const reference = parseFixedSkillReference(input.reference);
    const key = `${reference.kind}:${reference.id}`;
    if (seen.has(key)) invalid("同一技能或技能包不能同时引用多个版本。");
    seen.add(key);
    if (!Number.isSafeInteger(input.learningMinutes) || (input.learningMinutes as number) < 0 || (input.learningMinutes as number) > 10080) invalid("学习与配置工时须为 0 到 10080 分钟的估算。");
    return { reference, purpose: safeText(input.purpose, 500)!, learningMinutes: input.learningMinutes as number, environment: parseSkillUseEnvironment(input.environment) };
  });
}
export async function validateTaskSkillReferences(lookup: ReviewedSkillLookupPort, value: unknown): Promise<readonly TaskSkillReference[] | undefined> {
  const refs = parseTaskSkillReferences(value);
  for (const item of refs ?? []) await lookup.get(item.reference);
  return refs;
}
/** Call only when skillRefs are supplied; older tasks without the field remain valid. */
export function assertTaskSkillLearningIncluded(refs: readonly TaskSkillReference[] | undefined, estimatedMinutes: number): void {
  if (!refs?.length) return;
  const minutes = refs.reduce((total, item) => total + item.learningMinutes, 0);
  if (!Number.isFinite(estimatedMinutes) || estimatedMinutes < minutes) throw new DomainError("SKILL_LEARNING_NOT_IN_TASK_ESTIMATE", "学习、配置和试用时间需计入本任务原有的预计用时。", { recoveryAction: "调整本任务预计用时，或减少所选技能的学习范围。" });
}

type PublicationMetadata = { revision?: number; versionId?: string; bundleId?: string; compatibilityEvidence?: readonly SkillCompatibilityEvidence[] };
function metadata(value: SkillVersion | TrackBundle): PublicationMetadata { return value as (SkillVersion | TrackBundle) & PublicationMetadata; }
function reviewedRevision(value: SkillVersion | TrackBundle): number { return revision(metadata(value).revision ?? 1); }
function skillReference(skill: Skill, version: SkillVersion): FixedSkillReference {
  return { kind: "skill", id: skill.id, version: version.version, versionId: version.id, contentHash: version.contentHash, revision: reviewedRevision(version) };
}
function skillEvidence(version: SkillVersion): readonly SkillCompatibilityEvidence[] {
  const declared = metadata(version).compatibilityEvidence;
  if (declared) return declared;
  return version.compatibility.map(value => ({ agentId: value.agentId, level: "installer_declared", source: "official_documentation", clientVersion: value.agentVersion, os: null, checkedAt: version.reviewedAt, evidenceUrl: value.evidenceUrl, task: null, limitation: value.limitation }));
}
function exactReference(actual: FixedSkillReference, input: FixedSkillReference): void {
  if (hash(actual) !== hash(input)) throw new DomainError("SKILL_REFERENCE_STALE", "所选固定版本或审核内容已变化，请明确重新选择。", { status: 409, recoveryAction: "刷新已审核目录，保留现有用途后重新选择固定版本。", latestRevision: actual.revision });
}
function unavailable(): never { throw new DomainError("SKILL_REFERENCE_UNAVAILABLE", "所选固定版本已撤回、尚未发布或不存在。", { status: 409 }); }
async function skillOption(tx: SkillsTransaction, id: string, versionId: string, lock = false): Promise<ReviewedSkillOption> {
  const skill = await tx.getSkill(id, lock);
  const version = skill?.versions.find(item => item.id === versionId);
  if (!skill || !version || version.status !== "published") unavailable();
  assertVersion(version);
  if (version.skillId !== skill.id || version.id !== `${skill.id}@${version.commit}` || version.license.redistribution !== "allowed_with_notices") invalid("技能身份或许可与固定清单不一致。");
  return { reference: skillReference(skill, version), title: skill.title, summary: skill.summary, prerequisites: skill.prerequisites, compatibility: skillEvidence(version), requiredSkillVersions: [], optionalSkillVersionIds: [], limitations: [skill.tutorial.limitations] };
}
function bundleVersionId(bundle: TrackBundle): string {
  const meta = metadata(bundle);
  return meta.versionId ?? `${meta.bundleId ?? (bundle.id.endsWith(`@${bundle.version}`) ? bundle.id.slice(0, -(bundle.version.length + 1)) : bundle.id)}@${bundle.version}`;
}
/** A reference hash captures the exact reviewed bundle declaration and required member hashes. */
export function projectBundleReferenceHash(bundle: TrackBundle, members: readonly FixedSkillReference[]): string {
  return hash({ versionId: bundleVersionId(bundle), version: bundle.version, name: bundle.name, track: bundle.track, outcome: bundle.outcome, skillVersionIds: bundle.skillVersionIds, optionalSkillVersionIds: bundle.optionalSkillVersionIds, limitations: bundle.limitations, steps: bundle.steps, members: members.map(member => ({ id: member.id, versionId: member.versionId, version: member.version, contentHash: member.contentHash })) });
}
async function bundleOption(tx: SkillsTransaction, id: string, lock = false): Promise<ReviewedSkillOption> {
  const bundle = await tx.getBundle(id, lock);
  if (!bundle || bundle.status !== "published") unavailable();
  if (!bundle.skillVersionIds.length || bundle.skillVersionIds.length > MAX_REFERENCES || new Set(bundle.skillVersionIds).size !== bundle.skillVersionIds.length) invalid("技能包固定版本清单无效。");
  const options: ReviewedSkillOption[] = [];
  for (const versionId of [...bundle.skillVersionIds].sort()) {
    const option = await skillOption(tx, versionId.split("@", 1)[0], versionId, lock);
    options.push(option);
  }
  const members = bundle.skillVersionIds.map(id => options.find(option => option.reference.versionId === id)!.reference);
  const meta = metadata(bundle);
  const reference: FixedSkillReference = { kind: "bundle", id: bundle.id, version: bundle.version, versionId: bundleVersionId(bundle), contentHash: projectBundleReferenceHash(bundle, members), revision: reviewedRevision(bundle) };
  return { reference, title: bundle.name, summary: bundle.outcome, prerequisites: [...new Set(options.flatMap(option => option.prerequisites))], compatibility: meta.compatibilityEvidence ?? [], requiredSkillVersions: members, optionalSkillVersionIds: bundle.optionalSkillVersionIds, limitations: [...bundle.limitations, "单项工具声明或分别测试不能推定整包在同一环境兼容。"] };
}
export function createReviewedSkillLookupPort(repository: SkillsRepository): ReviewedSkillLookupPort {
  return {
    async list() {
      const result: ReviewedSkillOption[] = [];
      const skills = await repository.listSkills();
      const bundles = await repository.listBundles();
      for (const skill of skills) for (const version of skill.versions.filter(item => item.status === "published")) {
        try { result.push(await repository.transaction(tx => skillOption(tx, skill.id, version.id))); } catch (error) { if (!isDomainError(error)) throw error; }
      }
      for (const bundle of bundles.filter(item => item.status === "published")) {
        try { result.push(await repository.transaction(tx => bundleOption(tx, bundle.id))); } catch (error) { if (!isDomainError(error)) throw error; }
      }
      return result;
    },
    async get(value) {
      const reference = parseFixedSkillReference(value);
      return repository.transaction(async tx => {
        const option = reference.kind === "skill" ? await skillOption(tx, reference.id, reference.versionId, true) : await bundleOption(tx, reference.id, true);
        exactReference(option.reference, reference);
        return option;
      });
    },
  };
}

function signedIn(actor: Actor | null): Actor {
  if (!actor?.userId) throw new DomainError("UNAUTHENTICATED", "请先登录。", { status: 401 });
  return actor;
}
export class ProjectSkillSelectionService {
  readonly dependencies: ProjectSkillSelectionDependencies;
  constructor(dependencies: ProjectSkillSelectionDependencies) { this.dependencies = dependencies; }
  private async access(tx: ProjectSkillSelectionTransaction, actor: Actor, projectId: string, write = false): Promise<{ membership: ProjectMembershipAccess; readOnly: boolean }> {
    const membership = await this.dependencies.projectAccess.getMembership(projectId, actor.userId);
    if (!membership || membership.projectId !== projectId || membership.userId !== actor.userId || membership.status !== "active") throw new DomainError("PROJECT_SKILL_ACCESS_DENIED", "没有当前团队空间的访问权限。", { status: 403 });
    const project = await tx.getProject(projectId, write);
    if (!project || project.id !== projectId) throw new DomainError("PROJECT_NOT_FOUND", "团队空间不存在。", { status: 404 });
    if (write && membership.role !== "manager") throw new DomainError("PROJECT_SKILL_MANAGEMENT_REQUIRED", "需要团队空间管理员权限才能修改共用技能选择。", { status: 403 });
    if (write && (project.archived || project.readOnly)) throw new DomainError("PROJECT_READ_ONLY", "此团队空间只读，无法修改技能选择。", { status: 409 });
    return { membership, readOnly: project.archived || project.readOnly };
  }
  private assertStoredProject(state: ProjectSkillSelectionState | null, projectId: string): void {
    if (state && state.projectId !== projectId) throw new DomainError("PROJECT_SKILL_STORAGE_MISMATCH", "团队空间资料读取失败，请重试。", { status: 500 });
  }
  private async persist(tx: ProjectSkillSelectionTransaction, user: Actor, id: string, expectedRevision: number, selections: readonly TaskSkillReference[]): Promise<ProjectSkillSelectionState> {
    await this.access(tx, user, id, true);
    const current = await tx.get(id, true);
    this.assertStoredProject(current, id);
    if ((current?.revision ?? 0) !== expectedRevision) throw new DomainError("VERSION_CONFLICT", "项目技能选择已变化，请刷新后保留并核对本地输入。", { status: 409, latestRevision: current?.revision ?? 0 });
    await validateTaskSkillReferences(this.dependencies.reviewedSkills, selections);
    await this.access(tx, user, id, true);
    const state: ProjectSkillSelectionState = { projectId: id, revision: expectedRevision + 1, selections, updatedBy: user.userId, updatedAt: this.dependencies.clock.now().toISOString() };
    await tx.save(state, expectedRevision);
    await this.access(tx, user, id, true);
    return state;
  }
  async read(actor: Actor | null, projectId: string): Promise<ProjectSkillSelectionView> {
    const user = signedIn(actor); const id = identity(projectId);
    return this.dependencies.selections.transaction(async tx => {
      await this.access(tx, user, id);
      const state = await tx.get(id);
      this.assertStoredProject(state, id);
      const selections = state?.selections ?? [];
      const availability: ProjectSkillSelectionView["availability"][number][] = [];
      for (const item of selections) {
        try { await this.dependencies.reviewedSkills.get(item.reference); availability.push({ reference: item.reference, available: true, reason: null }); }
        catch (error) { if (!isDomainError(error)) throw error; availability.push({ reference: item.reference, available: false, reason: error.message }); }
      }
      const access = await this.access(tx, user, id);
      return { projectId: id, revision: state?.revision ?? 0, selections, availability, updatedBy: state?.updatedBy ?? null, updatedAt: state?.updatedAt ?? null, canManage: access.membership.role === "manager" && !access.readOnly, readOnly: access.readOnly };
    });
  }
  async catalog(actor: Actor | null, projectId: string): Promise<{ items: readonly ReviewedSkillOption[] }> {
    const user = signedIn(actor); const id = identity(projectId);
    return this.dependencies.selections.transaction(async tx => {
      await this.access(tx, user, id);
      const items = await this.dependencies.reviewedSkills.list();
      await this.access(tx, user, id);
      return { items };
    });
  }
  async save(actor: Actor | null, projectId: string, input: { expectedRevision: number; selections: unknown }): Promise<ProjectSkillSelectionState> {
    const user = signedIn(actor); const id = identity(projectId); const expectedRevision = revision(input.expectedRevision, true);
    const selections = parseTaskSkillReferences(input.selections);
    if (!selections) invalid("请提供技能选择列表；清除时使用空列表。");
    return this.dependencies.selections.transaction(tx => this.persist(tx, user, id, expectedRevision, selections));
  }
  /** M07 calls only after the user selects a source and target. No installation port is present. */
  async copy(actor: Actor | null, sourceProjectId: string, targetProjectId: string, expectedRevision: number): Promise<ProjectSkillSelectionState> {
    const user = signedIn(actor); const source = identity(sourceProjectId); const target = identity(targetProjectId); const expected = revision(expectedRevision, true);
    if (source === target) invalid("请选择不同的来源与目标空间。");
    return this.dependencies.selections.transaction(async tx => {
      await this.access(tx, user, source);
      await this.access(tx, user, target, true);
      const existing = await tx.get(source);
      this.assertStoredProject(existing, source);
      const selections = parseTaskSkillReferences(existing?.selections ?? [])!;
      const result = await this.persist(tx, user, target, expected, selections);
      await this.access(tx, user, source);
      await this.access(tx, user, target, true);
      return result;
    });
  }
}
export function createProjectSkillSelectionService(dependencies: ProjectSkillSelectionDependencies): ProjectSkillSelectionService { return new ProjectSkillSelectionService(dependencies); }

/** M07 owns feedback persistence and task outcome; this DTO is a user report, never platform verification. */
export interface SkillUseFeedback {
  reference: FixedSkillReference;
  environment: SkillUseEnvironment;
  purpose: string;
  learningMinutes: number;
  outcome: "helped" | "partial" | "did_not_help" | "not_used";
  note: string;
  evidenceSource: "user_reported";
}
/** For historical feedback, root first checks this exact ref against authorized stored project/task facts. */
export function parseSkillUseFeedback(value: unknown): SkillUseFeedback {
  const input = object(value, ["reference", "environment", "purpose", "learningMinutes", "outcome", "note", "evidenceSource"]);
  if (input.evidenceSource !== "user_reported" || !["helped", "partial", "did_not_help", "not_used"].includes(input.outcome as string)) invalid("技能反馈只能记录本人实际使用说明，不能声明平台已验证。");
  const ref = parseTaskSkillReferences([{ reference: input.reference, environment: input.environment, purpose: input.purpose, learningMinutes: input.learningMinutes }])![0];
  return { ...ref, outcome: input.outcome as SkillUseFeedback["outcome"], note: safeText(input.note, 1000)!, evidenceSource: "user_reported" };
}
/** For adopting a feedback item as a new current dependency, recheck current publication. */
export async function validateSkillUseFeedback(lookup: ReviewedSkillLookupPort, value: unknown): Promise<SkillUseFeedback> {
  const feedback = parseSkillUseFeedback(value); await lookup.get(feedback.reference); return feedback;
}
export async function createSkillReuseSnapshot(lookup: ReviewedSkillLookupPort, value: unknown): Promise<{ schemaVersion: "1"; skillRefs: readonly TaskSkillReference[]; installationAction: "none" }> {
  return { schemaVersion: "1", skillRefs: await validateTaskSkillReferences(lookup, value) ?? [], installationAction: "none" };
}
