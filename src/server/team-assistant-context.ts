import { createHash } from "node:crypto";
import type { Actor, Clock } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import type { FreshSessionGuard } from "../shared/personal-ai.ts";
import type { ParticipantProfile } from "../shared/participant.ts";
import { DomainError, isDomainError } from "../shared/errors.ts";
import type { PlanningFactsPort } from "../modules/planning/ports.ts";

/** Structural service ports: new modules remain owned by their module sessions. */
export interface AssistantProjectSource {
  project: { id: string; name: string; goal: string; minimumDeliverable: string; stage: string; timezone: string; deadline: string | null; revision: number };
  membership: { membershipId: string; projectId: string; userId: string; role: "manager" | "member"; status: string; revision?: number };
  members: readonly { membershipId: string; projectId: string; userId: string; role: "manager" | "member"; status: string; revision?: number }[];
}
export interface AssistantTaskSource {
  id: string; projectId: string; title: string; status: string; priority: string; kind: string;
  ownerMembershipId: string | null; reviewerMembershipId: string | null;
  deliverable: string; acceptanceCriteria: readonly string[]; dependencyTaskIds: readonly string[];
  blocker: string | null; revision: number; updatedAt: string;
  acceptance: { acceptedByUserId: string; acceptedAt: string; mode: string; evidenceRefs: readonly string[]; note: string } | null;
}
export interface AssistantPlanningSource {
  plan: { id: string; revision: number; status: string } | null;
  tasks: readonly AssistantTaskSource[]; tasksRevision: number;
  staleInputs: boolean; inputVersionsChanged: boolean;
}
export interface AssistantProgressSource {
  id: string; projectId: string; taskId: string; actorId: string; status: string;
  note: string; blocker: string | null; evidenceRefs: readonly string[]; createdAt: string;
}
export interface AssistantIntentionSource {
  userId: string; revision: number; membershipRevision: number; updatedAt: string;
  duties?: readonly string[]; experience?: string; wantsAiHelp?: boolean; helpQuestion?: string;
}
export interface AssistantOfficialRulesSource {
  eventId: string; rulesVersion: number; confirmationRevision: number; latestPublishedRulesVersion: number | null;
  catalog: { status: string; tracks: readonly { id: string; name: string; eligibility: { text: string } | null; scoringFocus: { text: string } | null }[] };
  requirements: readonly { id: string; label: string; necessity: string }[];
}
export interface AssistantTrackSource {
  projectId: string; needsReview: boolean;
  selection: { eventId: string; rulesVersion: number; confirmationRevision: number; trackId: string | null; trackName: string | null; revision: number; reason: string } | null;
}
/** Root maps R01's private profile; demographic/portrait data is deliberately absent. */
export interface PrivateAssistantProfileSource {
  userId: string; revision: number; updatedAt?: string | null;
  primaryRoles?: readonly string[]; supportingRoles?: readonly string[]; purposes?: readonly string[];
  purposeNote?: string; resume?: string; workLinks?: readonly { title: string; url: string }[];
}
/** Root maps only current R02 suggestions whose stored source remains available. */
export interface SharedAssistantAdviceSource {
  id: string; projectId: string; authorUserId: string; revision: number;
  title: string; body: string; status: "discussion" | "adopted" | "withdrawn";
  updatedAt: string; sourceKind?: string; sourceId?: string | null; sourceRevision?: number;
}
export interface TeamAssistantContextDependencies {
  database: DatabasePort; clock: Clock;
  planningFacts?: Pick<PlanningFactsPort, "lockVersions">;
  projects: {
    getProject(actor: Actor, projectId: string): Promise<AssistantProjectSource>;
    getMembership?(projectId: string, userId: string, sql?: SqlExecutor): Promise<{ membershipId: string; projectId: string; userId: string; role: "manager" | "member"; status: string } | null>;
    listProjects?(actor: Actor): Promise<readonly { id: string; stage: string }[]>;
  };
  planning: {
    getCurrent(actor: Actor, projectId: string): Promise<AssistantPlanningSource>;
    listProgress(actor: Actor, projectId: string): Promise<readonly AssistantProgressSource[]>;
  };
  collaboration: {
    getMyIntention(actor: Actor, projectId: string): Promise<{ projectId: string; needsConfirmation: boolean; intention: AssistantIntentionSource | null }>;
    getSharedIntentions(actor: Actor, projectId: string): Promise<{ projectId: string; intentions: readonly AssistantIntentionSource[] }>;
    getOfficialTracks(actor: Actor, projectId: string): Promise<AssistantTrackSource>;
  };
  officialRules: { getProjectTrackRules(projectId: string, sql: SqlExecutor): Promise<AssistantOfficialRulesSource | null> };
  participantProfiles: { get(actor: Actor, guard?: FreshSessionGuard): Promise<ParticipantProfile> };
  recruiting?: { getPrivateProfile(actor: Actor, guard?: FreshSessionGuard): Promise<PrivateAssistantProfileSource | null> };
  teamCollaboration?: { readShared(actor: Actor, projectId: string, guard?: FreshSessionGuard): Promise<readonly SharedAssistantAdviceSource[]> };
}

/** These shapes structurally implement R03's public context/memory contracts. */
export interface SpaceAssistantSource { id: string; label: string; href?: string }
export interface SpaceAssistantLink { id: string; label: string; href: string }
export interface SpaceAssistantContextSnapshot {
  projectId: string; fingerprint: string; facts: Readonly<Record<string, unknown>>;
  sources: readonly SpaceAssistantSource[]; missing: readonly string[]; links: readonly SpaceAssistantLink[]; capturedAt: string;
}
export interface SpaceAssistantMemoryItem {
  id: string; kind: "navigator" | "personal_memory"; content: string; projectId: string | null; createdAt: string;
}
export interface SpaceAssistantMemorySnapshot {
  fingerprint: string; items: readonly SpaceAssistantMemoryItem[];
  coverage: { retainedCount: number; selectedCount: number; description: string };
  sources: readonly SpaceAssistantSource[]; missing: readonly string[];
}
export interface SpaceAssistantMemorySelection { projectId: string; question: string; maxItems: number; maxBytes: number }

export const TEAM_ASSISTANT_CONTEXT_LIMITS = Object.freeze({
  contextBytes: 49_152, memoryCandidates: 60, memoryItems: 12, memoryBytes: 16_384, memoryItemBytes: 1_200,
  ownTasks: 12, reviewTasks: 12, dependencies: 20, teamTasks: 30, progress: 16, sharedAdvice: 12, sharedIntentions: 20, requirements: 20,
});
const forbidden = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|\p{Surrogate}/u;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
function unavailable(): never { throw new DomainError("TEAM_ASSISTANT_CONTEXT_UNAVAILABLE", "空间资料暂时无法安全读取，请稍后重新读取；未把读取失败当成空资料。", { status: 502 }); }
function changed(): never { throw new DomainError("TEAM_ASSISTANT_CONTEXT_CHANGED", "空间、共享建议或引用记忆已有变化，请重新读取后再提问。", { status: 409, recoveryAction: "reload_assistant_context" }); }
function invalidInput(): never { throw new DomainError("TEAM_ASSISTANT_CONTEXT_INPUT_INVALID", "空间或记忆读取范围无效，请重新打开空间助手。", { status: 422 }); }
function id(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 256 || /[\s\p{Cc}]/u.test(value) || forbidden.test(value)) invalidInput();
  return value;
}
function revision(value: unknown, empty = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (empty ? 0 : 1)) unavailable();
  return value;
}
function content(value: unknown): string {
  if (typeof value !== "string" || forbidden.test(value)) unavailable();
  return value.trim();
}
function short(value: unknown, maxBytes: number): string {
  const input = content(value); let output = "", bytes = 0;
  for (const char of input) { const size = Buffer.byteLength(char, "utf8"); if (bytes + size > maxBytes) break; output += char; bytes += size; }
  return output;
}
function instant(value: Date | string): string {
  const date = new Date(value); if (!Number.isFinite(date.getTime())) unavailable(); return date.toISOString();
}
function strings(value: readonly string[], max = 12, bytes = 180): string[] {
  if (!Array.isArray(value)) unavailable(); return value.slice(0, max).map(item => short(item, bytes));
}
function byId<T extends { id: string }>(items: readonly T[]): T[] { return [...items].sort((a, b) => a.id.localeCompare(b.id)); }
function membershipIdentity(detail: AssistantProjectSource) {
  return { projectId: detail.project.id, membershipId: detail.membership.membershipId, userId: detail.membership.userId,
    role: detail.membership.role, status: detail.membership.status, revision: detail.membership.revision ?? null };
}
function projectIdentity(detail: AssistantProjectSource) {
  return { ...membershipIdentity(detail), project: { id: detail.project.id, name: detail.project.name, goal: detail.project.goal,
    minimumDeliverable: detail.project.minimumDeliverable, stage: detail.project.stage, timezone: detail.project.timezone,
    deadline: detail.project.deadline, revision: detail.project.revision },
    members: [...detail.members].filter(item => item.status === "active").sort((a, b) => a.membershipId.localeCompare(b.membershipId))
      .map(item => ({ membershipId: item.membershipId, userId: item.userId, role: item.role, revision: item.revision ?? null })) };
}
function isDenied(error: unknown): boolean { return isDomainError(error) && error.status === 404 && ["PROJECT_UNAVAILABLE", "PROJECT_NOT_FOUND", "NOT_FOUND"].includes(error.code); }
type MessageRow = { id: string | number | bigint; project_id: string | null; role: "user" | "assistant"; content: string; created_at: Date | string };
function memoryItem(row: MessageRow): SpaceAssistantMemoryItem {
  if (!/^[1-9]\d*$/.test(String(row.id)) || !["user", "assistant"].includes(row.role)) unavailable();
  return { id: `navigator:${row.id}`, kind: "navigator", content: short(`${row.role === "user" ? "本人提问：" : "DSH 导航回复："}${content(row.content)}`, TEAM_ASSISTANT_CONTEXT_LIMITS.memoryItemBytes),
    projectId: row.project_id, createdAt: instant(row.created_at) };
}
type SourceScope = ReturnType<typeof membershipIdentity> & { stage: string };
function memoryIdentity(actor: Actor, items: readonly SpaceAssistantMemoryItem[], rows: readonly MessageRow[], scopes: ReadonlyMap<string, SourceScope>) {
  const originals = new Map(rows.map(row => [`navigator:${row.id}`, row]));
  return { userId: actor.userId, items: items.map(item => {
    const row = originals.get(item.id); if (!row) changed();
    return { item, fullContentHash: sha(content(row.content)), source: row.project_id ? scopes.get(row.project_id) ?? unavailable() : null };
  }) };
}
function queryTerms(question: string): string[] {
  const excluded = new Set(["什么", "怎么", "如何", "现在", "可以", "这个", "一下", "团队", "项目", "应该", "我们"]);
  const result = new Set<string>();
  for (const word of question.toLowerCase().match(/[\p{L}\p{N}]{2,40}/gu) ?? []) {
    if (/\p{Script=Han}/u.test(word)) {
      const chars = [...word]; for (let index = 0; index < chars.length - 1; index++) {
        const term = chars.slice(index, index + 2).join(""); if (!excluded.has(term)) result.add(term);
      }
    } else if (!excluded.has(word)) result.add(word);
    if (result.size >= 32) break;
  }
  return [...result].slice(0, 32);
}

/**
 * All ports must reuse the root DatabasePort's ambient executor. Reads are
 * sequential because parallel nested PostgreSQL savepoints are unsafe. Locks
 * live only for the sampling transaction, never throughout a DSH request.
 * Only personal navigator messages use direct SQL; M02/M03/M05/R01/R02 facts
 * remain behind their public, currently authorized service ports.
 */
export function createTeamAssistantContextPorts(deps: TeamAssistantContextDependencies) {
  async function authorize(sql: SqlExecutor, actor: Actor, guard?: FreshSessionGuard) {
    if (!actor || typeof actor.userId !== "string" || !actor.userId || actor.userId.length > 256 || forbidden.test(actor.userId))
      throw new DomainError("UNAUTHENTICATED", "请登录后打开个人空间助手。", { status: 401 });
    const account = await sql.query("SELECT id FROM auth_users WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL FOR SHARE", [actor.userId]);
    if (!account.rowCount) throw new DomainError("UNAUTHENTICATED", "登录身份已失效，请重新登录。", { status: 401 });
    await guard?.(sql);
  }
  async function project(actor: Actor, projectId: string, writable = false): Promise<AssistantProjectSource> {
    const detail = await deps.projects.getProject(actor, projectId);
    if (detail.project.id !== projectId || detail.membership.projectId !== projectId || detail.membership.userId !== actor.userId || detail.membership.status !== "active")
      throw new DomainError("PROJECT_UNAVAILABLE", "空间不存在或你已不在这个空间中。", { status: 404 });
    if (writable && detail.project.stage === "archived") throw new DomainError("PROJECT_ARCHIVED", "空间已归档，请先恢复空间再请求新的助手建议。", { status: 409 });
    return detail;
  }
  async function scope(sql: SqlExecutor, actor: Actor, projectId: string, guard?: FreshSessionGuard) {
    id(projectId); await authorize(sql, actor, guard);
    // M05 starts with this lock; taking it before M02 avoids inversion when
    // getCurrent() later enters the already locked project's transaction.
    await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`planning:${projectId}`]);
    await deps.planningFacts?.lockVersions(projectId, sql, actor);
    return project(actor, projectId, true);
  }
  async function sampleContext(sql: SqlExecutor, actor: Actor, projectId: string, guard?: FreshSessionGuard): Promise<SpaceAssistantContextSnapshot> {
    const detail = await scope(sql, actor, projectId, guard);
    const current = await deps.planning.getCurrent(actor, projectId);
    const progress = await deps.planning.listProgress(actor, projectId);
    const mine = await deps.collaboration.getMyIntention(actor, projectId);
    const shared = await deps.collaboration.getSharedIntentions(actor, projectId);
    const track = await deps.collaboration.getOfficialTracks(actor, projectId);
    const rules = await deps.officialRules.getProjectTrackRules(projectId, sql);
    const participant = await deps.participantProfiles.get(actor, guard);
    const recruiting = deps.recruiting ? await deps.recruiting.getPrivateProfile(actor, guard) : null;
    const advice = deps.teamCollaboration ? await deps.teamCollaboration.readShared(actor, projectId, guard) : [];
    if (mine.projectId !== projectId || shared.projectId !== projectId || track.projectId !== projectId || participant.userId !== actor.userId
      || (mine.intention && mine.intention.userId !== actor.userId) || (recruiting && recruiting.userId !== actor.userId)) unavailable();
    revision(detail.project.revision); revision(current.tasksRevision, true); revision(participant.revision, true);
    const members = detail.members.filter(item => item.status === "active");
    if (members.some(item => item.projectId !== projectId) || !members.some(item => item.membershipId === detail.membership.membershipId && item.userId === actor.userId)) unavailable();
    const memberIds = new Set(members.map(item => item.membershipId));
    const memberUsers = new Set(members.map(item => item.userId));
    const allTasks = byId(current.tasks);
    const taskIds = new Set(allTasks.map(item => item.id));
    if (taskIds.size !== allTasks.length || allTasks.some(item => item.projectId !== projectId || !["todo", "in_progress", "blocked", "review", "done", "cancelled"].includes(item.status))) unavailable();
    if (progress.some(item => item.projectId !== projectId)) unavailable();
    const intentions = shared.intentions.filter(item => memberUsers.has(item.userId));
    const effectiveAdvice = advice.filter(item => item.status !== "withdrawn");
    if (advice.some(item => item.projectId !== projectId) || effectiveAdvice.some(item => !memberUsers.has(item.authorUserId) || !["discussion", "adopted"].includes(item.status))) unavailable();
    const own = allTasks.filter(item => item.ownerMembershipId === detail.membership.membershipId && item.status !== "cancelled");
    const review = allTasks.filter(item => item.status === "review" && item.ownerMembershipId !== detail.membership.membershipId
      && (item.reviewerMembershipId === detail.membership.membershipId || detail.membership.role === "manager"));
    const pendingFirst = (a: AssistantTaskSource, b: AssistantTaskSource) => Number(a.status === "done") - Number(b.status === "done") || a.id.localeCompare(b.id);
    const selectedOwn = own.sort(pendingFirst).slice(0, TEAM_ASSISTANT_CONTEXT_LIMITS.ownTasks);
    const selectedReview = review.slice(0, TEAM_ASSISTANT_CONTEXT_LIMITS.reviewTasks);
    const relevantIds = new Set([...selectedOwn, ...selectedReview].map(item => item.id));
    const dependencyIds = new Set([...selectedOwn, ...selectedReview].flatMap(item => [...item.dependencyTaskIds]));
    const dependencies = allTasks.filter(item => dependencyIds.has(item.id)).slice(0, TEAM_ASSISTANT_CONTEXT_LIMITS.dependencies);
    for (const dependency of dependencies) relevantIds.add(dependency.id);
    const recentProgress = [...progress].filter(item => relevantIds.has(item.taskId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, TEAM_ASSISTANT_CONTEXT_LIMITS.progress);
    const missing: string[] = ["只读取当前空间的已保存事实和本人资料；未读取代码、私人测评原始答案、队友私人对话或外部群聊。", "长文本和列表仅带入有界摘录；不表示已读取全部规则原文或全部历史成果。"]; 
    if (!current.plan) missing.push("当前没有生效计划；空任务列表不代表已经完成或无需工作。");
    if (current.staleInputs || current.inputVersionsChanged) missing.push("当前计划依据需重新核对；不得把旧任务安排当成仍适用的承诺。");
    if (!rules) missing.push("尚未确认本空间的正式比赛要求；资格、赛道和必交材料仍未知。");
    if (track.needsReview) missing.push("官方赛道选择尚未完成或需要重新核对。");
    if (!mine.intention || mine.needsConfirmation) missing.push("本人职责意愿尚未确认；旧意愿不能当成本次确定分工。");
    if (!deps.recruiting) missing.push("参赛目的与简历扩展尚未提供；不据此推断个人能力。");
    if (!deps.teamCollaboration) missing.push("团队共享建议尚未接入本次上下文。");
    const omission = (count: number, shown: number, label: string) => { if (count > shown) missing.push(`${label}共有 ${count} 项，本次仅带入 ${shown} 项。`); };
    omission(own.length, selectedOwn.length, "本人任务"); omission(review.length, selectedReview.length, "待本人检查的任务");
    omission(allTasks.length, Math.min(allTasks.length, TEAM_ASSISTANT_CONTEXT_LIMITS.teamTasks), "团队任务");
    omission(dependencyIds.size, dependencies.length, "引用的前置任务");
    if ([...dependencyIds].some(value => !taskIds.has(value))) missing.push("部分前置任务没有当前记录，需先核对依赖；不得假设它已完成。");
    if (allTasks.some(item => item.ownerMembershipId !== null && !memberIds.has(item.ownerMembershipId))) missing.push("部分任务负责人已经不在当前成员列表中，请管理员重新安排；不能假称仍有人负责。");
    if (allTasks.some(item => item.status === "done" && (!item.acceptance || !item.acceptance.evidenceRefs.length))) missing.push("部分历史完成状态缺少检查依据，不能据此声称已经检查通过。");
    omission(intentions.length, Math.min(intentions.length, TEAM_ASSISTANT_CONTEXT_LIMITS.sharedIntentions), "队友共享意愿");
    omission(effectiveAdvice.length, Math.min(effectiveAdvice.length, TEAM_ASSISTANT_CONTEXT_LIMITS.sharedAdvice), "有效共享建议");
    const task = (value: AssistantTaskSource) => ({ id: value.id, title: short(value.title, 240), status: value.status,
      priority: value.priority, kind: value.kind, ownerMembershipId: value.ownerMembershipId, reviewerMembershipId: value.reviewerMembershipId,
      ownerIsCurrentMember: value.ownerMembershipId !== null && memberIds.has(value.ownerMembershipId),
      deliverable: short(value.deliverable, 450), acceptanceCriteria: strings(value.acceptanceCriteria, 6, 180),
      dependencyTaskIds: strings(value.dependencyTaskIds, 20, 256), blocker: value.blocker === null ? null : short(value.blocker, 450),
      revision: revision(value.revision), updatedAt: instant(value.updatedAt),
      acceptance: value.acceptance ? { acceptedByUserId: value.acceptance.acceptedByUserId, acceptedAt: instant(value.acceptance.acceptedAt),
        mode: value.acceptance.mode, evidenceCount: value.acceptance.evidenceRefs.length, note: short(value.acceptance.note, 240) } : null,
      checkedComplete: value.status === "done" && value.acceptance !== null && value.acceptance.evidenceRefs.length > 0 });
    const intention = (value: AssistantIntentionSource) => ({ userId: value.userId, revision: revision(value.revision),
      membershipRevision: revision(value.membershipRevision), updatedAt: instant(value.updatedAt),
      ...(value.duties !== undefined ? { duties: strings(value.duties, 8, 80) } : {}),
      ...(value.experience !== undefined ? { experience: short(value.experience, 480) } : {}),
      ...(value.wantsAiHelp !== undefined ? { wantsAiHelp: value.wantsAiHelp } : {}),
      ...(value.helpQuestion !== undefined ? { helpQuestion: short(value.helpQuestion, 360) } : {}) });
    const privateProfile = recruiting ? { userId: actor.userId, revision: revision(recruiting.revision, true),
      primaryRoles: strings(recruiting.primaryRoles ?? [], 9, 80), supportingRoles: strings(recruiting.supportingRoles ?? [], 9, 80),
      purposes: strings(recruiting.purposes ?? [], 5, 80), purposeNote: short(recruiting.purposeNote ?? "", 450), resume: short(recruiting.resume ?? "", 1_200),
      workLinks: (recruiting.workLinks ?? []).slice(0, 6).map(item => ({ title: short(item.title, 120), url: short(item.url, 500) })), updatedAt: recruiting.updatedAt ?? null } : null;
    const base = `/app/projects/${encodeURIComponent(projectId)}`;
    const facts: Record<string, unknown> = {
      project: { id: projectId, name: short(detail.project.name, 360), goal: short(detail.project.goal, 4_000), minimumDeliverable: short(detail.project.minimumDeliverable, 4_000),
        stage: detail.project.stage, timezone: detail.project.timezone, deadline: detail.project.deadline, revision: detail.project.revision },
      me: membershipIdentity(detail),
      teammates: members.slice(0, 30).map(item => ({ membershipId: item.membershipId, userId: item.userId, role: item.role })),
      myIntention: { needsConfirmation: mine.needsConfirmation, intention: mine.intention ? intention(mine.intention) : null },
      sharedIntentions: intentions.slice(0, TEAM_ASSISTANT_CONTEXT_LIMITS.sharedIntentions).map(intention),
      officialRules: rules ? { eventId: rules.eventId, rulesVersion: rules.rulesVersion, confirmationRevision: rules.confirmationRevision,
        latestPublishedRulesVersion: rules.latestPublishedRulesVersion, catalogStatus: rules.catalog.status,
        requirements: rules.requirements.slice(0, TEAM_ASSISTANT_CONTEXT_LIMITS.requirements).map(item => ({ id: item.id, label: short(item.label, 360), necessity: item.necessity })) } : null,
      officialTrack: { needsReview: track.needsReview, selection: track.selection ? { eventId: track.selection.eventId, trackId: track.selection.trackId,
        trackName: track.selection.trackName, revision: track.selection.revision, rulesVersion: track.selection.rulesVersion,
        confirmationRevision: track.selection.confirmationRevision, reason: short(track.selection.reason, 450),
        detail: rules?.catalog.tracks.filter(item => item.id === track.selection!.trackId).map(item => ({ id: item.id, name: short(item.name, 360),
          eligibility: item.eligibility ? short(item.eligibility.text, 900) : null, scoringFocus: item.scoringFocus ? short(item.scoringFocus.text, 900) : null }))[0] ?? null } : null },
      plan: { id: current.plan?.id ?? null, revision: current.plan?.revision ?? null, status: current.plan?.status ?? "not_applied",
        tasksRevision: current.tasksRevision, staleInputs: current.staleInputs, inputVersionsChanged: current.inputVersionsChanged },
      myTasks: selectedOwn.map(task), reviewTasks: selectedReview.map(task), dependencies: dependencies.map(task),
      teamTasks: allTasks.slice(0, TEAM_ASSISTANT_CONTEXT_LIMITS.teamTasks).map(task),
      recentProgress: recentProgress.map(item => ({ id: item.id, taskId: item.taskId, actorId: item.actorId, status: item.status,
        note: short(item.note, 450), blocker: item.blocker === null ? null : short(item.blocker, 450), evidenceCount: item.evidenceRefs.length, createdAt: instant(item.createdAt) })),
      sharedAdvice: [...effectiveAdvice].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
        .slice(0, TEAM_ASSISTANT_CONTEXT_LIMITS.sharedAdvice).map(item => ({ id: item.id, authorUserId: item.authorUserId, revision: revision(item.revision),
          title: short(item.title, 180), body: short(item.body, 900), status: item.status, updatedAt: instant(item.updatedAt),
          sourceKind: item.sourceKind ?? "manual", sourceId: item.sourceId ?? null, sourceRevision: item.sourceRevision ?? null })),
      ownProfile: { revision: participant.revision, firstHackathon: participant.firstHackathon, developmentExperience: participant.developmentExperience,
        city: short(participant.city, 240), skills: strings(participant.skills, 20, 150), interests: strings(participant.interests, 12, 120),
        projectIdea: short(participant.projectIdea, 1_200), availableHoursPerDay: participant.availableHoursPerDay,
        presentationExperience: participant.presentationExperience, updatedAt: participant.updatedAt, recruiting: privateProfile },
    };
    // Fingerprint complete service-provided identities, including the tails of
    // shortened fields. Read-time evaluation timestamps never enter identity.
    const identity = { userId: actor.userId, project: projectIdentity(detail),
      plan: current.plan ? { id: current.plan.id, revision: current.plan.revision, status: current.plan.status } : null,
      tasksRevision: current.tasksRevision, staleInputs: current.staleInputs, inputVersionsChanged: current.inputVersionsChanged,
      tasks: allTasks.map(item => ({ ...task(item), fullContent: { title: item.title, deliverable: item.deliverable, criteria: item.acceptanceCriteria, blocker: item.blocker } })),
      progress: byId(progress).map(item => ({ id: item.id, taskId: item.taskId, actorId: item.actorId, status: item.status, note: item.note, blocker: item.blocker, evidenceRefs: item.evidenceRefs, createdAt: item.createdAt })),
      myIntention: { needsConfirmation: mine.needsConfirmation, intention: mine.intention ? { ...intention(mine.intention), fullContent: { duties: mine.intention.duties, experience: mine.intention.experience, helpQuestion: mine.intention.helpQuestion } } : null },
      sharedIntentions: [...intentions].sort((a, b) => a.userId.localeCompare(b.userId)), rules, track: { needsReview: track.needsReview, selection: track.selection },
      participant: { revision: participant.revision, ...facts.ownProfile as Record<string, unknown>, fullProjectIdea: participant.projectIdea },
      recruiting: privateProfile, advice: byId(effectiveAdvice), availablePorts: { recruiting: !!deps.recruiting, teamCollaboration: !!deps.teamCollaboration } };
    const sources: SpaceAssistantSource[] = [{ id: "space-project", label: "当前空间目标、最小成果和成员", href: base },
      { id: "space-planning", label: "当前任务、依赖与实际检查记录", href: `${base}/plan` },
      { id: "space-duties", label: "本人职责与队友明确共享的意愿", href: `${base}/assessment` },
      { id: "own-participant-profile", label: "本人填写的私人参赛画像", href: "/app/account#participant-profile" }];
    if (rules) sources.push({ id: "space-confirmed-rules", label: `空间已确认比赛要求第 ${rules.rulesVersion} 版`, href: `${base}/rules` });
    if (recruiting) sources.push({ id: "own-recruiting-profile", label: "本人填写的参赛目的与简历", href: "/app/account#recruiting-profile" });
    if (deps.teamCollaboration) sources.push({ id: "space-shared-advice", label: "当前有效的团队共享建议和已采纳决定", href: `${base}#team-feed` });
    // Preserve essential task facts first; trim lower-priority extra records
    // if a large legitimate project exceeds this request's serialized budget.
    const trimOrder = ["sharedIntentions", "recentProgress", "sharedAdvice", "teamTasks", "dependencies", "reviewTasks", "myTasks", "teammates"];
    let trimmed = false;
    for (const key of trimOrder) {
      const array = facts[key] as unknown[];
      while (Buffer.byteLength(JSON.stringify({ facts, sources, missing }), "utf8") > TEAM_ASSISTANT_CONTEXT_LIMITS.contextBytes - 3_000 && array.length > (key === "myTasks" ? 1 : 0)) { array.pop(); trimmed = true; }
    }
    if (trimmed) missing.push("空间资料较多，本次已减少额外列表；完整原记录仍保留，任务页可查看全部内容。");
    const links: SpaceAssistantLink[] = [
      { id: "tasks", label: "查看我的任务与交付要求", href: `${base}/plan` },
      { id: "goal", label: "写清楚作品目标与最小成果", href: `${base}#project-goal` },
      { id: "rules", label: "核对比赛要求与官方赛道", href: `${base}/rules` },
      { id: "duties", label: "选择职责与确认分工", href: `${base}/assessment` },
      { id: "availability", label: "确认我能投入的时间", href: `${base}/team` },
      { id: "profile", label: "补充本人经验、职责与参赛目的", href: "/app/account#recruiting-profile" },
      { id: "resources", label: "工具与已审核资料", href: "/resources" },
      { id: "inspiration", label: "视觉与组件灵感", href: "/inspiration" },
      { id: "github", label: "保存代码与 GitHub 指南", href: `/github?projectId=${encodeURIComponent(projectId)}` },
      { id: "roadshow", label: "准备演示与路演", href: `/roadshow?projectId=${encodeURIComponent(projectId)}` },
      { id: "ppt", label: "准备 PPT 材料", href: `/ppt?projectId=${encodeURIComponent(projectId)}` },
    ];
    await authorize(sql, actor, guard);
    const fresh = await project(actor, projectId, true);
    if (canonical(projectIdentity(detail)) !== canonical(projectIdentity(fresh))) changed();
    const snapshot: SpaceAssistantContextSnapshot = { projectId, fingerprint: sha(canonical(identity)), facts, sources, missing, links, capturedAt: deps.clock.now().toISOString() };
    if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > TEAM_ASSISTANT_CONTEXT_LIMITS.contextBytes) unavailable();
    return snapshot;
  }
  async function sourceProjects(actor: Actor, rows: readonly MessageRow[], sql: SqlExecutor): Promise<Map<string, SourceScope>> {
    const scopes = new Map<string, SourceScope>();
    // Root supplies these public read-only M02 methods to avoid taking other
    // source-project write locks after the current project's lock. Their
    // current access/role/stage is sampled again before any answer commits.
    const projectStages = deps.projects.getMembership && deps.projects.listProjects
      ? new Map((await deps.projects.listProjects(actor)).map(item => [item.id, item.stage])) : null;
    for (const projectId of [...new Set(rows.map(row => row.project_id).filter((value): value is string => value !== null))].sort()) {
      if (projectStages && deps.projects.getMembership) {
        const membership = await deps.projects.getMembership(projectId, actor.userId, sql);
        if (membership?.status === "active" && membership.projectId === projectId && membership.userId === actor.userId && projectStages.has(projectId))
          scopes.set(projectId, { ...membership, revision: null, stage: projectStages.get(projectId)! });
      } else {
        try { const detail = await project(actor, projectId); scopes.set(projectId, { ...membershipIdentity(detail), stage: detail.project.stage }); }
        catch (error) { if (!isDenied(error)) throw error; }
      }
    }
    return scopes;
  }
  async function sampleMemory(sql: SqlExecutor, actor: Actor, input: SpaceAssistantMemorySelection, guard?: FreshSessionGuard): Promise<SpaceAssistantMemorySnapshot> {
    if (!input || typeof input.question !== "string" || input.question.length > 6_000 || forbidden.test(input.question)
      || !Number.isSafeInteger(input.maxItems) || input.maxItems < 1 || input.maxItems > 100
      || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 256 || input.maxBytes > 65_536) invalidInput();
    const maxItems = Math.min(input.maxItems, TEAM_ASSISTANT_CONTEXT_LIMITS.memoryItems);
    const maxBytes = Math.min(input.maxBytes, TEAM_ASSISTANT_CONTEXT_LIMITS.memoryBytes);
    const activeProject = await scope(sql, actor, input.projectId, guard);
    const count = (await sql.query<{ retained_count: string | number }>("SELECT count(*) AS retained_count FROM personal_dsh_messages m JOIN personal_dsh_sessions s ON s.id=m.session_id WHERE s.user_id=$1", [actor.userId])).rows[0];
    const retainedCount = Number(count?.retained_count ?? 0);
    if (!Number.isSafeInteger(retainedCount) || retainedCount < 0) unavailable();
    const terms = queryTerms(input.question);
    // Search old retained history by actual question terms as well as keeping
    // recent context. Only bounded rows are loaded; SQL LIKE values are bound
    // and escape its wildcard syntax, never assembled into SQL instructions.
    const recentLimit = terms.length ? 20 : TEAM_ASSISTANT_CONTEXT_LIMITS.memoryCandidates;
    const recent = (await sql.query<MessageRow>("SELECT m.id::text AS id,m.project_id,m.role,m.content,m.created_at FROM personal_dsh_messages m JOIN personal_dsh_sessions s ON s.id=m.session_id WHERE s.user_id=$1 ORDER BY m.id DESC LIMIT $2 FOR SHARE OF m,s", [actor.userId, recentLimit])).rows;
    const patterns = terms.map(term => `%${term.replace(/[\\%_]/g, char => `\\${char}`)}%`);
    const relevant = patterns.length ? (await sql.query<MessageRow>("SELECT m.id::text AS id,m.project_id,m.role,m.content,m.created_at FROM personal_dsh_messages m JOIN personal_dsh_sessions s ON s.id=m.session_id WHERE s.user_id=$1 AND lower(m.content) LIKE ANY($2::text[]) AND NOT(m.id=ANY($3::bigint[])) ORDER BY m.id DESC LIMIT $4 FOR SHARE OF m,s", [actor.userId, patterns, recent.map(item => String(item.id)), TEAM_ASSISTANT_CONTEXT_LIMITS.memoryCandidates - recent.length])).rows : [];
    const rows = [...recent, ...relevant];
    const scopes = await sourceProjects(actor, rows, sql);
    const eligible = rows.filter(row => row.project_id === null || scopes.has(row.project_id));
    const ranked = eligible.map((row, index) => ({ row, index, score: terms.filter(term => content(row.content).toLowerCase().includes(term)).length * 100
      + (row.project_id === input.projectId ? 5 : 0) })).sort((a, b) => b.score - a.score || a.index - b.index);
    const selectedRows: MessageRow[] = [], items: SpaceAssistantMemoryItem[] = [];
    for (const { row } of ranked) {
      const item = memoryItem(row);
      if (Buffer.byteLength(JSON.stringify([...items, item]), "utf8") > maxBytes) continue;
      items.push(item); selectedRows.push(row); if (items.length === maxItems) break;
    }
    // Stable chronological presentation after relevance selection.
    const selected = items.sort((a, b) => a.createdAt.localeCompare(b.createdAt)
      || (BigInt(a.id.slice(10)) < BigInt(b.id.slice(10)) ? -1 : a.id === b.id ? 0 : 1));
    const missing: string[] = ["继承的是本人本站导航历史；原数据库记录保留，本次仅选择相关或最近摘录，未一次性发送全部历史。", "本人私人记忆不会自动发布给队友；其他空间来源仍需当前访问权限。"]; 
    if (!selected.length) missing.push("本次没有可带入的导航记忆，不能假称已了解过往想法。");
    if (rows.length !== eligible.length) missing.push("已排除本人当前无权访问的其他空间来源。");
    if (retainedCount > rows.length) missing.push(`已存 ${retainedCount} 条导航记录，本次只带入 ${rows.length} 条相关或最近候选；其余记录未带入。`);
    if (eligible.length > selected.length) missing.push(`本次从 ${eligible.length} 条可访问候选中带入 ${selected.length} 条摘录，未带入其余内容。`);
    const sources: SpaceAssistantSource[] = selected.map(item => ({ id: item.id, label: `${item.projectId ? "本人有权访问空间的导航记录" : "本人站内导航记录"} · ${item.createdAt}` }));
    await authorize(sql, actor, guard);
    const freshProject = await project(actor, input.projectId, true);
    if (canonical(membershipIdentity(activeProject)) !== canonical(membershipIdentity(freshProject))) changed();
    const finalScopes = await sourceProjects(actor, selectedRows, sql);
    for (const row of selectedRows) if (row.project_id && (!finalScopes.has(row.project_id)
      || canonical(scopes.get(row.project_id)!) !== canonical(finalScopes.get(row.project_id)!))) changed();
    return { fingerprint: sha(canonical(memoryIdentity(actor, selected, selectedRows, scopes))), items: selected,
      coverage: { retainedCount, selectedCount: selected.length, description: `本人导航历史保留 ${retainedCount} 条；本次读取 ${rows.length} 条相关或最近候选，选择 ${selected.length} 条有界摘录。` }, sources, missing };
  }
  const context = {
    async read(actor: Actor, projectId: string, _sql: SqlExecutor, guard?: FreshSessionGuard) {
      return deps.database.transaction(sql => sampleContext(sql, actor, projectId, guard));
    },
    async assertCurrent(actor: Actor, snapshot: SpaceAssistantContextSnapshot, _sql: SqlExecutor, guard?: FreshSessionGuard) {
      if (!snapshot || !/^[a-f0-9]{64}$/.test(snapshot.fingerprint)) invalidInput();
      await deps.database.transaction(async sql => {
        const fresh = await sampleContext(sql, actor, snapshot.projectId, guard);
        if (fresh.fingerprint !== snapshot.fingerprint) changed();
      });
    },
  };
  const memory = {
    async select(actor: Actor, input: SpaceAssistantMemorySelection, _sql: SqlExecutor, guard?: FreshSessionGuard) {
      return deps.database.transaction(sql => sampleMemory(sql, actor, input, guard));
    },
    async assertCurrent(actor: Actor, snapshot: SpaceAssistantMemorySnapshot, _sql: SqlExecutor, guard?: FreshSessionGuard) {
      if (!snapshot || !/^[a-f0-9]{64}$/.test(snapshot.fingerprint) || !Array.isArray(snapshot.items) || snapshot.items.length > TEAM_ASSISTANT_CONTEXT_LIMITS.memoryItems
        || snapshot.items.some(item => item.kind !== "navigator" || !/^navigator:[1-9]\d*$/.test(item.id))) invalidInput();
      await deps.database.transaction(async sql => {
        await authorize(sql, actor, guard);
        const messageIds = snapshot.items.map(item => item.id.slice(10));
        const rows = messageIds.length ? (await sql.query<MessageRow>("SELECT m.id::text AS id,m.project_id,m.role,m.content,m.created_at FROM personal_dsh_messages m JOIN personal_dsh_sessions s ON s.id=m.session_id WHERE s.user_id=$1 AND m.id=ANY($2::bigint[]) FOR SHARE OF m,s", [actor.userId, messageIds])).rows : [];
        if (rows.length !== messageIds.length) changed();
        const scopes = await sourceProjects(actor, rows, sql);
        const originals = new Map(rows.map(row => [memoryItem(row).id, row]));
        for (const item of snapshot.items) {
          const row = originals.get(item.id); if (!row || (row.project_id !== null && !scopes.has(row.project_id)) || canonical(memoryItem(row)) !== canonical(item)) changed();
        }
        if (sha(canonical(memoryIdentity(actor, snapshot.items, rows, scopes))) !== snapshot.fingerprint) changed();
        await authorize(sql, actor, guard);
        const finalScopes = await sourceProjects(actor, rows, sql);
        for (const [projectId, detail] of scopes) if (!finalScopes.has(projectId) || canonical(detail) !== canonical(finalScopes.get(projectId)!)) changed();
      });
    },
  };
  return { context, memory,
    async read(actor: Actor, projectId: string, question: string, guard?: FreshSessionGuard) {
      return deps.database.transaction(async sql => ({ context: await sampleContext(sql, actor, projectId, guard),
        memory: await sampleMemory(sql, actor, { projectId, question, maxItems: TEAM_ASSISTANT_CONTEXT_LIMITS.memoryItems, maxBytes: TEAM_ASSISTANT_CONTEXT_LIMITS.memoryBytes }, guard) }));
    },
  };
}
