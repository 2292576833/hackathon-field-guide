import type { Actor, ProjectMembershipAccess } from "../../../shared/contracts.ts";
import { DomainError } from "../../../shared/errors.ts";
import type { SqlExecutor } from "../../../shared/persistence.ts";
import type { TeamCollaborationAccessPort, TeamShareSourcePort, TeamTaskActivityPort } from "../ports.ts";
import type { SuggestionAudit, TeamCollaborationRepository, TeamCollaborationTransaction } from "../repository.ts";
import { TeamCollaborationService } from "../service.ts";
import type { PublishSuggestionCommand, ShareSourceKind, SuggestionReceipt, TaskActivity, TeamSuggestion } from "../types.ts";

export const PROJECT_ID = "project-team-test";
export const OTHER_PROJECT_ID = "project-other-test";
export const NOW = "2026-10-09T08:00:00.000Z";
export const author: Actor = { userId: "alice", platformRoles: ["user"] };
export const teammate: Actor = { userId: "bob", platformRoles: ["user"] };
export const manager: Actor = { userId: "manager", platformRoles: ["user"] };

type MutableMembership = { -readonly [Key in keyof ProjectMembershipAccess]: ProjectMembershipAccess[Key] };
interface ReceiptEntry { scope: string; key: string; fingerprint: string; receipt: SuggestionReceipt }
interface ProjectState {
  suggestions: Map<string, TeamSuggestion>;
  audits: SuggestionAudit[];
  versions: TeamSuggestion[];
  receipts: Map<string, ReceiptEntry>;
}
function emptyState(): ProjectState { return { suggestions: new Map(), audits: [], versions: [], receipts: new Map() }; }
function conflict(latestRevision?: number): never {
  throw new DomainError("VERSION_CONFLICT", "测试夹具记录版本已变化。", { status: 409, latestRevision, recoveryAction: "review_latest_version" });
}
function invalid(message: string): never { throw new DomainError("INVALID_INPUT", message); }
function validate(value: TeamSuggestion, audit: SuggestionAudit, projectId: string) {
  if (value.projectId !== projectId || !Number.isSafeInteger(value.revision) || value.revision < 1) invalid("测试记录归属或版本无效。");
  if (value.status === "withdrawn" && (value.title !== "" || value.body !== "" || value.withdrawnAt === null)) invalid("测试撤回记录必须清除正文。");
  if (audit.projectId !== projectId || audit.suggestionId !== value.id || audit.revision !== value.revision || audit.occurredAt !== value.updatedAt) invalid("测试审计必须对应当前版本。");
}

/** Test-only storage. Each project's transaction gets a deep clone and commits atomically. */
export class TestTeamCollaborationRepository implements TeamCollaborationRepository {
  private readonly projects = new Map<string, ProjectState>();
  private readonly tails = new Map<string, Promise<void>>();
  readonly executors: SqlExecutor[] = [];
  readonly sqlQueries: string[] = [];
  commits = 0;
  rollbacks = 0;
  beforeCommit: (() => void | Promise<void>) | undefined;

  snapshot(projectId = PROJECT_ID) {
    const state = structuredClone(this.projects.get(projectId) ?? emptyState());
    return { suggestions: [...state.suggestions.values()], audits: state.audits, versions: state.versions, receipts: [...state.receipts.values()] };
  }

  async transaction<T>(projectId: string, work: (transaction: TeamCollaborationTransaction) => Promise<T>): Promise<T> {
    const previous = this.tails.get(projectId) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => gate);
    this.tails.set(projectId, tail);
    await previous;
    const state = structuredClone(this.projects.get(projectId) ?? emptyState());
    const sql: SqlExecutor = { query: async statement => {
      this.sqlQueries.push(statement);
      throw new Error("Test ports must not access production SQL or write M05 state.");
    } };
    this.executors.push(sql);
    const record = (value: TeamSuggestion, audit: SuggestionAudit) => {
      validate(value, audit, projectId);
      state.suggestions.set(value.id, structuredClone(value));
      state.versions.push(structuredClone(value));
      state.audits.push(structuredClone(audit));
    };
    const tx: TeamCollaborationTransaction = {
      sql,
      async get(id) { return structuredClone(state.suggestions.get(id) ?? null); },
      async list(limit) {
        return [...state.suggestions.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id)).slice(0, limit).map(value => structuredClone(value));
      },
      async insert(value, audit) {
        if (state.suggestions.has(value.id)) conflict(state.suggestions.get(value.id)!.revision);
        if (value.revision !== 1) invalid("测试新记录须从第一版开始。");
        record(value, audit);
      },
      async replace(value, expectedRevision, audit) {
        const current = state.suggestions.get(value.id);
        if (!current) throw new DomainError("NOT_FOUND", "测试记录不存在。", { status: 404 });
        if (current.revision !== expectedRevision) conflict(current.revision);
        if (value.revision !== expectedRevision + 1 || value.authorUserId !== current.authorUserId || value.authorMembershipId !== current.authorMembershipId || value.createdAt !== current.createdAt || JSON.stringify(value.source) !== JSON.stringify(current.source) || current.status === "withdrawn") invalid("测试记录不能更改归属、来源或恢复撤回内容。");
        record(value, audit);
      },
      async getReceipt(scope, key, fingerprint) {
        const value = state.receipts.get(JSON.stringify([scope, key]));
        if (value && value.fingerprint !== fingerprint) throw new DomainError("IDEMPOTENCY_CONFLICT", "同一操作标识的测试内容已变化。", { status: 409 });
        return value ? structuredClone(value.receipt) : null;
      },
      async putReceipt(scope, key, fingerprint, receipt) {
        const mapKey = JSON.stringify([scope, key]);
        if (state.receipts.has(mapKey)) throw new DomainError("IDEMPOTENCY_CONFLICT", "测试操作回执不能覆写。", { status: 409 });
        state.receipts.set(mapKey, { scope, key, fingerprint, receipt: structuredClone(receipt) });
      },
    };
    try {
      const result = await work(tx);
      await this.beforeCommit?.();
      this.projects.set(projectId, structuredClone(state));
      this.commits += 1;
      return structuredClone(result);
    } catch (error) {
      this.rollbacks += 1;
      throw error;
    } finally {
      release();
      if (this.tails.get(projectId) === tail) this.tails.delete(projectId);
    }
  }
}

export interface TestSource {
  sourceKind: Exclude<ShareSourceKind, "manual">;
  sourceId: string;
  ownerUserId: string;
  projectId: string | null;
  label: string;
  revision: number;
  available: boolean;
  succeeded: boolean;
  /** Never returned by the metadata-only source port. */
  privateBody: string;
}
type SourceInput = Parameters<TeamShareSourcePort["verifySource"]>[0];
export interface TestHooks {
  onAccess?: (input: { projectId: string; actor: Actor; transaction: SqlExecutor }, call: number) => void | Promise<void>;
  onSource?: (input: SourceInput, call: number) => void | Promise<void>;
  onActivities?: () => void | Promise<void>;
}

export function taskActivity(overrides: Partial<TaskActivity> = {}): TaskActivity {
  return { kind: "task", id: "progress-1", taskId: "m05-task-1", title: "完成可演示流程", actorUserId: author.userId,
    occurredAt: NOW, status: "review", note: "已交出演示成果，等待队友检查", evidenceRefs: ["evidence-demo"], checked: false, ...overrides };
}

export function setup() {
  const repository = new TestTeamCollaborationRepository();
  const memberships = new Map<string, MutableMembership>();
  const readOnlyProjects = new Set<string>();
  const disabledAccounts = new Set<string>();
  const sources = new Map<string, TestSource>();
  const activities: TaskActivity[] = [];
  const hooks: TestHooks = {};
  const accessCalls: Array<{ projectId: string; actor: Actor; transaction: SqlExecutor }> = [];
  const sourceCalls: Array<SourceInput & { transaction: SqlExecutor }> = [];
  const activityCalls: Array<{ projectId: string; actor: Actor; transaction: SqlExecutor; limit: number }> = [];
  let now = NOW;
  let idSequence = 0;
  let keySequence = 0;
  const memberKey = (userId: string, projectId: string) => JSON.stringify([projectId, userId]);
  const addMembership = (actor: Actor, projectId = PROJECT_ID, role: "manager" | "member" = "member") => {
    const value: MutableMembership = { membershipId: `${projectId}-${actor.userId}`, projectId, userId: actor.userId, role, status: "active" };
    memberships.set(memberKey(actor.userId, projectId), value);
    return value;
  };
  addMembership(author); addMembership(teammate); addMembership(manager, PROJECT_ID, "manager");
  const membership = (actor: Actor, projectId = PROJECT_ID): MutableMembership => {
    const value = memberships.get(memberKey(actor.userId, projectId));
    if (!value) throw new Error("Test membership does not exist.");
    return value;
  };
  for (const [sourceKind, sourceId, ownerUserId, projectId] of [
    ["navigator", "navigator-alice", author.userId, null],
    ["space_assistant", "assistant-alice", author.userId, PROJECT_ID],
    ["feasibility", "feasibility-alice", author.userId, PROJECT_ID],
    ["navigator", "navigator-bob", teammate.userId, null],
    ["space_assistant", "assistant-other-project", author.userId, OTHER_PROJECT_ID],
  ] as const) {
    sources.set(sourceId, { sourceKind, sourceId, ownerUserId, projectId, label: `服务端来源：${sourceKind}`, revision: 1,
      available: true, succeeded: true, privateBody: `私人完整回答：${sourceId}，未主动共享部分` });
  }
  const accessPort: TeamCollaborationAccessPort = { async lockAccess(projectId, actor, transaction) {
    const input = { projectId, actor, transaction };
    accessCalls.push(input); await hooks.onAccess?.(input, accessCalls.length);
    const current = memberships.get(memberKey(actor.userId, projectId));
    if (!current || disabledAccounts.has(actor.userId)) throw new DomainError("PROJECT_ACCESS_DENIED", "测试账号或成员权限已失效。", { status: 403 });
    return { membership: structuredClone(current), readOnly: readOnlyProjects.has(projectId) };
  } };
  const sourcePort: TeamShareSourcePort = { async verifySource(input, transaction) {
    sourceCalls.push({ ...structuredClone(input), transaction });
    await hooks.onSource?.(input, sourceCalls.length);
    const current = memberships.get(memberKey(input.actor.userId, input.projectId));
    if (!current || current.status !== "active" || disabledAccounts.has(input.actor.userId)) return null;
    if (input.source.sourceKind === "manual") return input.source.sourceId === null ? { sourceKind: "manual", sourceId: null, label: "成员备注", revision: 1 } : null;
    const value = sources.get(input.source.sourceId ?? "");
    if (!value || !value.available || !value.succeeded || value.sourceKind !== input.source.sourceKind || value.ownerUserId !== input.ownerUserId || (value.projectId !== null && value.projectId !== input.projectId)) return null;
    return { sourceKind: value.sourceKind, sourceId: value.sourceId, label: value.label, revision: value.revision };
  } };
  const activityPort: TeamTaskActivityPort = { async readActivities(projectId, actor, transaction, limit) {
    activityCalls.push({ projectId, actor, transaction, limit });
    await hooks.onActivities?.();
    return structuredClone(activities.slice(0, limit));
  } };
  const service = new TeamCollaborationService({ repository, access: accessPort, sources: sourcePort, activities: activityPort,
    clock: { now: () => new Date(now) }, ids: { next: () => `r02-test-${++idSequence}` } });
  const command = (overrides: Partial<PublishSuggestionCommand> = {}): PublishSuggestionCommand => ({
    sourceKind: "navigator", sourceId: "navigator-alice", title: "下一步先验证演示链路", body: "本人选择并编辑后共享的建议片段。",
    idempotencyKey: `operation-${++keySequence}`, ...overrides,
  });
  return { repository, service, memberships, membership, addMembership, readOnlyProjects, disabledAccounts, sources, activities, hooks,
    accessPort, sourcePort, activityPort, accessCalls, sourceCalls, activityCalls, command, setNow: (value: string) => { now = value; } };
}
