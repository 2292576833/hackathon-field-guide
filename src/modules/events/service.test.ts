import test from "node:test";
import assert from "node:assert/strict";
import type { Actor, Clock, ProjectAccessPort, ProjectMembershipAccess } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import type { EventRuleVersion } from "./domain.ts";
import type { AnalysisContent, AnalysisInput, AnalysisModelPort, ProjectWriteAccessPort } from "./model.ts";
import { EventsService } from "./service.ts";
import type { EventsServiceDependencies } from "./service.ts";
import { MemoryEventsRepository } from "./testing/memory-repository.ts";

const reviewer: Actor = { userId: "reviewer", platformRoles: ["reviewer"] };
const manager: Actor = { userId: "manager", platformRoles: ["user"] };
const member: Actor = { userId: "member", platformRoles: ["user"] };
const removed: Actor = { userId: "removed", platformRoles: ["user"] };
const otherManager: Actor = { userId: "other-manager", platformRoles: ["user"] };
const checkedAt = "2026-10-08T04:00:00.000Z";

class TestClock implements Clock {
  private instant = Date.parse(checkedAt);
  now(): Date { return new Date(this.instant); }
  advance(milliseconds: number): void { this.instant += milliseconds; }
}
class TestProjectAccess implements ProjectAccessPort, ProjectWriteAccessPort {
  private members = new Map<string, ProjectMembershipAccess>();
  constructor() {
    this.set("project-1", manager.userId, "manager", "active");
    this.set("project-1", member.userId, "member", "active");
    this.set("project-1", removed.userId, "manager", "removed");
    this.set("project-2", otherManager.userId, "manager", "active");
  }
  set(projectId: string, userId: string, role: ProjectMembershipAccess["role"], status: ProjectMembershipAccess["status"]): void {
    this.members.set(JSON.stringify([projectId, userId]), { membershipId: `${projectId}-${userId}`, projectId, userId, role, status });
  }
  async getMembership(projectId: string, userId: string): Promise<ProjectMembershipAccess | null> {
    return structuredClone(this.members.get(JSON.stringify([projectId, userId])) ?? null);
  }
  getMembershipForUpdate(_executor: SqlExecutor | undefined, projectId: string, userId: string): Promise<ProjectMembershipAccess | null> {
    return this.getMembership(projectId, userId);
  }
}
function harness(options: Partial<EventsServiceDependencies> = {}) {
  const repository = new MemoryEventsRepository();
  const projectAccess = new TestProjectAccess();
  const clock = new TestClock();
  let sequence = 0;
  const service = new EventsService({ repository, projectAccess, projectWriteAccess: projectAccess, clock, ids: { next: () => `test-id-${++sequence}` }, ...options });
  return { repository, projectAccess, clock, service };
}
function input(projectId = "project-1", rulesVersion = 1): AnalysisInput {
  return { projectId, eventId: "event-1", rulesVersion, backgroundVersion: 1, background: { goal: "完成最小可交演示", experience: "首次参加" } };
}
function rules(eventId = "event-1", version = 1): EventRuleVersion {
  const deadline = "2026-10-20 20:00 Asia/Shanghai";
  return {
    eventId, version, createdAt: checkedAt,
    metadata: { name: "试用黑客松", organizer: "测试主办方", format: "online", region: "中国", officialUrl: "https://example.test/rules" },
    sources: [{ id: "official", eventId, version, sourceConfigId: null, url: "https://example.test/rules", kind: "official", contentHash: `fixture-content-v${version}`, fetchedAt: checkedAt, trustScope: "official_rules", status: "available" }],
    evidence: [
      { id: "evidence-demo", eventId, version, sourceId: "official", fieldKey: "requirement.demo", excerpt: "提交演示材料。", locator: "规则/必交材料", rawDateText: null, verifiedBy: reviewer.userId, verifiedAt: checkedAt, conflictsWith: [] },
      { id: "evidence-deadline", eventId, version, sourceId: "official", fieldKey: "submission.endsAt", excerpt: `提交截止 ${deadline}。`, locator: "规则/截止时间", rawDateText: deadline, verifiedBy: reviewer.userId, verifiedAt: checkedAt, conflictsWith: [] },
    ],
    facts: ["eligibility", "fees", "team_size", "ai_policy"].map(key => ({ key, statement: `${key} 尚未确认。`, status: "unknown", evidenceIds: [] })),
    stages: [{ id: "submission", stageType: "submission", name: "作品提交", startsAt: null, endsAt: { rawText: deadline, timeZone: "Asia/Shanghai", utc: "2026-10-20T12:00:00.000Z", dateOnly: false, evidenceIds: ["evidence-deadline"] }, submissionUrl: "https://example.test/submit" }],
    requirements: [{ id: "demo", label: "演示材料", necessity: "required", stageId: "submission", evidenceIds: ["evidence-demo"] }],
    qualityFlags: ["missing_information"],
  };
}
function content(value = rules()): AnalysisContent {
  return {
    facts: [{ statement: "规则列明必交演示材料。", evidenceIds: [value.evidence[0]!.id] }],
    suggestions: [{ text: "先围绕最小演示整理材料。", evidenceIds: [value.evidence[0]!.id], backgroundKeys: ["goal"] }],
    unknowns: value.facts.filter(fact => fact.status === "unknown").map(fact => ({ field: fact.key, question: `请向主办方确认 ${fact.key}。` })),
    checklist: [{ requirementId: value.requirements[0]!.id, action: "核对并准备演示材料。" }],
  };
}
async function publish(context: ReturnType<typeof harness>, value = rules()) {
  const current = await context.repository.getEvent(value.eventId);
  const candidate = await context.service.createCandidate(reviewer, value, current?.revision ?? 0);
  const reviewing = await context.service.requestReview(reviewer, value.eventId, candidate.revision);
  return context.service.publishCandidate(reviewer, value.eventId, reviewing.revision);
}
function error(code: string, status?: number) {
  return (cause: unknown): boolean => {
    assert.ok(cause instanceof DomainError);
    assert.equal(cause.code, code);
    if (status !== undefined) assert.equal(cause.status, status);
    return true;
  };
}
function model(generate: AnalysisModelPort["generate"]): AnalysisModelPort {
  return { modelVersion: "simulated-model-v1", promptVersion: "events-prompt-v1", generate };
}

test("public publishing requires an operator, review, and a current revision", async () => {
  const context = harness();
  await assert.rejects(context.service.createCandidate(manager, rules(), 0), error("REVIEW_PERMISSION_REQUIRED", 403));
  assert.equal(context.repository.inspect().events.length, 0);
  const candidate = await context.service.createCandidate(reviewer, rules(), 0);
  await assert.rejects(context.service.getEvent("event-1"), error("NOT_FOUND", 404));
  await assert.rejects(context.service.publishCandidate(reviewer, "event-1", candidate.revision), error("REVIEW_REQUIRED"));
  const reviewing = await context.service.requestReview(reviewer, "event-1", candidate.revision);
  await assert.rejects(context.service.requestReview(reviewer, "event-1", reviewing.revision), error("INVALID_PUBLICATION_STATE"));
  await assert.rejects(context.service.publishCandidate(manager, "event-1", reviewing.revision), error("REVIEW_PERMISSION_REQUIRED", 403));
  await assert.rejects(context.service.publishCandidate(reviewer, "event-1", candidate.revision), error("VERSION_CONFLICT", 409));
  const published = await context.service.publishCandidate(reviewer, "event-1", reviewing.revision);
  assert.equal(published.event.lastVerifiedAt, checkedAt);
  assert.equal((await context.service.listEvents()).items.length, 1);
  assert.deepEqual(context.repository.inspect().audits.map(audit => audit.type), ["EventPublished"]);
});

test("new drafts and pending candidates retain the previous public rules; archive hides them", async () => {
  const context = harness();
  await publish(context);
  const nextRules = rules("event-1", 2);
  nextRules.metadata.name = "候选新名称";
  const candidate = await context.service.createCandidate(reviewer, nextRules, 3);
  assert.equal(candidate.publishedVersion, 1);
  assert.equal((await context.service.getEvent("event-1")).rules.version, 1);
  const pending = await context.service.requestReview(reviewer, "event-1", candidate.revision);
  const listed = await context.service.listEvents();
  assert.equal(listed.items[0]!.rules.version, 1);
  assert.notEqual(listed.items[0]!.rules.metadata.name, nextRules.metadata.name);
  await assert.rejects(context.service.confirmProjectRules(manager, "project-1", "event-1", 2, 0), error("NOT_FOUND", 404));
  const archived = await context.service.archiveEvent(reviewer, "event-1", pending.revision);
  assert.equal((await context.service.listEvents()).items.length, 0);
  await assert.rejects(context.service.getEvent("event-1"), error("NOT_FOUND", 404));
  await assert.rejects(context.service.createCandidate(reviewer, rules("event-1", 3), archived.revision), error("EVENT_ARCHIVED"));
  assert.equal((await context.service.listEvents()).items.length, 0);
  assert.equal((await context.repository.getEvent("event-1"))!.publicationStatus, "archived");
});

test("public filters and pagination apply to the published version", async () => {
  const context = harness();
  await publish(context, rules("event-1"));
  await publish(context, rules("event-2"));
  await publish(context, rules("event-3"));
  const first = await context.service.listEvents({ limit: 2, format: "online", region: "中国", query: "试用", beginnerEligibility: "unknown", phase: "awaiting_submission" });
  assert.deepEqual(first.items.map(item => item.event.id), ["event-1", "event-2"]);
  assert.equal(first.nextCursor, "event-2");
  const second = await context.service.listEvents({ limit: 2, cursor: first.nextCursor! });
  assert.deepEqual(second.items.map(item => item.event.id), ["event-3"]);
  assert.equal(second.nextCursor, null);
  assert.equal((await context.service.listEvents({ region: "未收录地区" })).items.length, 0);
  await assert.rejects(context.service.listEvents({ limit: 51 }), error("INVALID_FILTER"));
});

test("only active project managers confirm; removed membership remains inaccessible", async () => {
  const context = harness();
  await publish(context);
  await assert.rejects(context.service.confirmProjectRules(member, "project-1", "event-1", 1, 0), error("PROJECT_MANAGER_REQUIRED", 403));
  await assert.rejects(context.service.confirmProjectRules(removed, "project-1", "event-1", 1, 0), error("NOT_FOUND", 404));
  await assert.rejects(context.service.getProjectRules(removed, "project-1"), error("NOT_FOUND", 404));
  await assert.rejects(context.service.confirmProjectRules(manager, "project-2", "event-1", 1, 0), error("NOT_FOUND", 404));
  assert.equal(context.repository.inspect().confirmations.length, 0);
  const confirmed = await context.service.confirmProjectRules(manager, "project-1", "event-1", 1, 0);
  assert.equal(confirmed.confirmedBy, manager.userId);
  assert.equal((await context.service.getProjectRules(member, "project-1")).rules?.version, 1);
});

test("private writes require the transactional membership adapter", async () => {
  const context = harness({ projectWriteAccess: undefined });
  await publish(context);
  await assert.rejects(context.service.confirmProjectRules(manager, "project-1", "event-1", 1, 0), error("PROJECT_WRITE_ACCESS_UNAVAILABLE", 503));
  assert.equal(context.repository.inspect().confirmations.length, 0);
});

test("two confirmations with the same expected revision commit only once", async () => {
  const context = harness();
  await publish(context);
  const outcomes = await Promise.allSettled([
    context.service.confirmProjectRules(manager, "project-1", "event-1", 1, 0),
    context.service.confirmProjectRules(manager, "project-1", "event-1", 1, 0),
  ]);
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
  const failed = outcomes.find(result => result.status === "rejected");
  assert.ok(failed?.status === "rejected");
  error("VERSION_CONFLICT", 409)(failed.reason);
  assert.equal(context.repository.inspect().confirmations[0]!.revision, 1);
  assert.equal(context.repository.inspect().audits.filter(audit => audit.type === "ProjectRequirementsConfirmed").length, 1);
});

test("public rule updates expose a difference without replacing the project snapshot", async () => {
  const context = harness();
  await publish(context);
  const original = await context.service.confirmProjectRules(manager, "project-1", "event-1", 1, 0);
  const previousRules = (await context.service.getProjectRules(member, "project-1")).rules;
  const changed = rules("event-1", 2);
  changed.metadata.name = "规则更新后的试用赛事";
  changed.stages[0]!.endsAt!.rawText = "2026-10-19 20:00 Asia/Shanghai";
  changed.stages[0]!.endsAt!.utc = "2026-10-19T12:00:00.000Z";
  changed.evidence[1]!.rawDateText = changed.stages[0]!.endsAt!.rawText;
  changed.evidence[1]!.excerpt = "提交截止 2026-10-19 20:00 Asia/Shanghai。";
  await publish(context, changed);
  const project = await context.service.getProjectRules(member, "project-1");
  assert.deepEqual(project.confirmation, original);
  assert.deepEqual(project.rules, previousRules);
  const difference = await context.service.getProjectChanges(member, "project-1");
  assert.equal(difference.latestVersion, 2);
  assert.equal(difference.needsConfirmation, true);
  assert.ok(difference.changes.some(change => change.path === "/stages/submission/endsAt/utc"));
  assert.equal(project.rules!.stages[0]!.endsAt!.utc, "2026-10-20T12:00:00.000Z");
  assert.equal((await context.service.getEvent("event-1")).rules.version, 2);
  assert.equal(context.repository.inspect().audits.at(-1)!.type, "EventRulesChanged");
});

test("immutable rule snapshots cannot be changed through returned objects", async () => {
  const context = harness();
  await publish(context);
  const fetched = await context.repository.getRules("event-1", 1);
  assert.ok(fetched);
  fetched.metadata.name = "客户端不应覆盖存储";
  fetched.evidence.length = 0;
  const next = await context.repository.getRules("event-1", 1);
  assert.notEqual(next!.metadata.name, fetched.metadata.name);
  assert.ok(next!.evidence.length > 0);
});

test("model-unavailable projects can save and confirm a grounded manual draft", async () => {
  const context = harness();
  await publish(context);
  await assert.rejects(context.service.queueAnalysis(manager, input(), "manual-fallback"), error("MODEL_UNAVAILABLE", 503));
  const draft = await context.service.saveManualAnalysis(manager, input(), content());
  assert.equal(draft.origin, "manual");
  assert.equal(draft.modelVersion, null);
  assert.equal(draft.status, "draft");
  assert.equal(context.repository.inspect().runs.length, 0);
  const fetched = await context.service.getAnalysis(member, "project-1", draft.id);
  assert.equal(fetched.currentBackgroundVersion, null);
  assert.equal(fetched.backgroundFreshness, "unknown");
  await context.service.confirmProjectRules(manager, "project-1", "event-1", 1, 0, draft.id);
  assert.equal((await context.service.getAnalysis(member, "project-1", draft.id)).status, "confirmed");
});

test("historical analyses return the original evidence snapshot after public rules change", async () => {
  const context = harness();
  await publish(context);
  const draft = await context.service.saveManualAnalysis(manager, input(), content());
  const updated = rules("event-1", 2);
  updated.metadata.name = "新公开名称";
  await publish(context, updated);
  const historical = await context.service.getAnalysis(member, "project-1", draft.id);
  assert.equal(historical.rules.version, 1);
  assert.equal(historical.rules.metadata.name, "试用黑客松");
  assert.equal(historical.rules.evidence[0]!.version, 1);
  assert.equal((await context.service.getEvent("event-1")).rules.version, 2);
});

test("background updates mark analyses outdated and reject stale confirmation without replacing the prior report", async () => {
  let currentVersion = 1;
  const context = harness({ projectBackgroundVersion: { getCurrentBackgroundVersion: async projectId => { assert.equal(projectId, "project-1"); return currentVersion; } } });
  await publish(context);
  const first = await context.service.saveManualAnalysis(manager, input(), content());
  const current = await context.service.getAnalysis(member, "project-1", first.id);
  assert.equal(current.currentBackgroundVersion, 1);
  assert.equal(current.backgroundFreshness, "current");
  const confirmation = await context.service.confirmProjectRules(manager, "project-1", "event-1", 1, 0, first.id);
  const replacement = await context.service.saveManualAnalysis(manager, input(), content());
  currentVersion = 2;
  const stale = await context.service.getAnalysis(member, "project-1", replacement.id);
  assert.equal(stale.currentBackgroundVersion, 2);
  assert.equal(stale.backgroundFreshness, "outdated");
  assert.equal(stale.backgroundVersion, 1);
  await assert.rejects(context.service.confirmProjectRules(manager, "project-1", "event-1", 1, 1, replacement.id), error("ANALYSIS_BACKGROUND_CHANGED", 409));
  assert.deepEqual((await context.service.getProjectRules(member, "project-1")).confirmation, confirmation);
  assert.equal((await context.service.getAnalysis(member, "project-1", first.id)).status, "confirmed");
  assert.equal((await context.service.getAnalysis(member, "project-1", replacement.id)).status, "draft");
  assert.equal(context.repository.inspect().audits.filter(audit => audit.type === "ProjectRequirementsConfirmed").length, 1);
});

test("confirming a replacement analysis preserves and supersedes the previous report", async () => {
  const context = harness();
  await publish(context);
  const first = await context.service.saveManualAnalysis(manager, input(), content());
  await context.service.confirmProjectRules(manager, "project-1", "event-1", 1, 0, first.id);
  const newContent = content();
  newContent.suggestions[0]!.text = "新的项目建议。";
  const second = await context.service.saveManualAnalysis(manager, input(), newContent);
  assert.equal((await context.service.getAnalysis(member, "project-1", first.id)).status, "confirmed");
  await context.service.confirmProjectRules(manager, "project-1", "event-1", 1, 1, second.id);
  const previous = await context.service.getAnalysis(member, "project-1", first.id);
  assert.equal(previous.status, "superseded");
  assert.deepEqual(previous.content, first.content);
  assert.equal((await context.service.getAnalysis(member, "project-1", second.id)).status, "confirmed");
  const audit = context.repository.inspect().audits.at(-1)!;
  assert.equal(audit.version, 2);
  assert.equal(audit.rulesEventId, "event-1");
  assert.equal(audit.rulesVersion, 1);
});

test("cross-project analysis IDs are rejected on read and confirmation", async () => {
  const context = harness();
  await publish(context);
  const privateDraft = await context.service.saveManualAnalysis(otherManager, input("project-2"), content());
  await assert.rejects(context.service.getAnalysis(manager, "project-1", privateDraft.id), error("NOT_FOUND", 404));
  await assert.rejects(context.service.confirmProjectRules(manager, "project-1", "event-1", 1, 0, privateDraft.id), error("NOT_FOUND", 404));
  assert.equal(context.repository.inspect().confirmations.length, 0);
  assert.equal((await context.service.getAnalysis(otherManager, "project-2", privateDraft.id)).status, "draft");
});

test("analysis idempotency reuses identical inputs and rejects changed contents", async () => {
  let calls = 0;
  const context = harness({ model: model(async () => { calls++; return { content: content() }; }) });
  await publish(context);
  const [first, repeated] = await Promise.all([
    context.service.queueAnalysis(manager, input(), "request-1"),
    context.service.queueAnalysis(manager, { ...input(), background: { experience: "首次参加", goal: "完成最小可交演示" } }, "request-1"),
  ]);
  assert.deepEqual(repeated, first);
  await assert.rejects(context.service.queueAnalysis(manager, { ...input(), backgroundVersion: 2 }, "request-1"), error("IDEMPOTENCY_CONFLICT", 409));
  assert.equal(context.repository.inspect().runs.length, 1);
  assert.equal(context.repository.inspect().analyses.length, 1);
  assert.equal(calls, 0);
  const result = await context.service.processAnalysisRun(first.id);
  assert.equal(result.status, "succeeded");
  assert.equal((await context.service.processAnalysisRun(first.id)).status, "succeeded");
  assert.equal(calls, 1);
});

test("model facts citing nonexistent evidence fail validation and never become successful", async () => {
  const invalid = content();
  invalid.facts[0]!.evidenceIds = ["invented-evidence"];
  const context = harness({ model: model(async () => ({ content: invalid })) });
  await publish(context);
  const run = await context.service.queueAnalysis(manager, input(), "invalid-evidence");
  const finished = await context.service.processAnalysisRun(run.id);
  assert.equal(finished.status, "failed");
  assert.equal(finished.errorCode, "INVALID_ANALYSIS");
  assert.equal((await context.service.getAnalysis(manager, "project-1", run.analysisId)).content, null);
  await assert.rejects(context.service.retryAnalysis(manager, "project-1", run.id), error("RETRY_NOT_ALLOWED"));
});

test("timeouts abort provider calls and retries stop at the configured attempt limit", async () => {
  const signals: AbortSignal[] = [];
  const context = harness({ model: model(async (_input, signal) => { signals.push(signal); return new Promise(() => {}); }), modelTimeoutMs: 5, maxModelAttempts: 2 });
  await publish(context);
  const queued = await context.service.queueAnalysis(manager, input(), "timeout");
  const first = await context.service.processAnalysisRun(queued.id);
  assert.equal(first.status, "failed");
  assert.equal(first.errorCode, "MODEL_TIMEOUT");
  assert.equal(first.attempts, 1);
  assert.equal(signals[0]!.aborted, true);
  await context.service.retryAnalysis(manager, "project-1", queued.id);
  const second = await context.service.processAnalysisRun(queued.id);
  assert.equal(second.attempts, 2);
  assert.equal(signals[1]!.aborted, true);
  await assert.rejects(context.service.retryAnalysis(manager, "project-1", queued.id), error("RETRY_NOT_ALLOWED"));
  assert.equal((await context.service.getAnalysis(manager, "project-1", queued.analysisId)).content, null);
});

test("cancelling a queued analysis prevents model execution", async () => {
  let calls = 0;
  const context = harness({ model: model(async () => { calls++; return { content: content() }; }) });
  await publish(context);
  const run = await context.service.queueAnalysis(manager, input(), "cancel-queued");
  await context.service.cancelAnalysis(manager, "project-1", run.id);
  assert.equal((await context.service.processAnalysisRun(run.id)).status, "cancelled");
  assert.equal(calls, 0);
  assert.equal((await context.service.getAnalysis(manager, "project-1", run.analysisId)).content, null);
});

test("cancelling a running analysis discards the late model result", async () => {
  let begin!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; });
  let finish!: (value: { content: AnalysisContent }) => void;
  const result = new Promise<{ content: AnalysisContent }>(resolve => { finish = resolve; });
  const context = harness({ model: model(async () => { begin(); return result; }) });
  await publish(context);
  const run = await context.service.queueAnalysis(manager, input(), "cancel-running");
  const worker = context.service.processAnalysisRun(run.id);
  await started;
  const cancelled = await context.service.cancelAnalysis(manager, "project-1", run.id);
  finish({ content: content() });
  assert.deepEqual(await worker, cancelled);
  assert.equal((await context.service.getAnalysis(manager, "project-1", run.analysisId)).content, null);
});

test("revoked managers cannot send previously queued private inputs to a model", async () => {
  let calls = 0;
  const context = harness({ model: model(async () => { calls++; return { content: content() }; }) });
  await publish(context);
  const run = await context.service.queueAnalysis(manager, input(), "revoke-before-start");
  context.projectAccess.set("project-1", manager.userId, "manager", "removed");
  const finished = await context.service.processAnalysisRun(run.id);
  assert.equal(finished.status, "failed");
  assert.equal(finished.errorCode, "PROJECT_ACCESS_REVOKED");
  assert.equal(calls, 0);
  assert.equal(context.repository.inspect().analyses[0]!.content, null);
});

test("membership revocation while a model runs discards the completed report", async () => {
  let begin!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; });
  let finish!: (value: { content: AnalysisContent }) => void;
  const result = new Promise<{ content: AnalysisContent }>(resolve => { finish = resolve; });
  const context = harness({ model: model(async () => { begin(); return result; }) });
  await publish(context);
  const run = await context.service.queueAnalysis(manager, input(), "revoke-running");
  const worker = context.service.processAnalysisRun(run.id);
  await started;
  context.projectAccess.set("project-1", manager.userId, "member", "active");
  finish({ content: content() });
  const finished = await worker;
  assert.equal(finished.status, "failed");
  assert.equal(finished.errorCode, "PROJECT_ACCESS_REVOKED");
  assert.equal(context.repository.inspect().analyses[0]!.content, null);
});

test("root transport uncertain errors stay NETWORK_UNKNOWN and cannot replay the same run", async () => {
  let calls = 0;
  const uncertain = Object.assign(new DomainError("AI_NETWORK_UNCERTAIN", "不公开供应商详情。", { status: 503 }), { externalState: "unknown" });
  const context = harness({ model: model(async () => { calls++; throw uncertain; }) });
  await publish(context);
  const queued = await context.service.queueAnalysis(manager, input(), "uncertain-root-request");
  const failed = await context.service.processAnalysisRun(queued.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "NETWORK_UNKNOWN");
  await assert.rejects(context.service.retryAnalysis(manager, "project-1", queued.id), error("RETRY_NOT_ALLOWED"));
  assert.equal((await context.service.processAnalysisRun(queued.id)).status, "failed");
  assert.equal(calls, 1);
});

test("archived projects terminally fail queued jobs without a model call", async () => {
  let calls = 0;
  let archived = false;
  const context = harness({ model: model(async () => { calls++; return { content: content() }; }) });
  const lookup = context.projectAccess.getMembershipForUpdate.bind(context.projectAccess);
  context.projectAccess.getMembershipForUpdate = async (executor, projectId, userId) => {
    if (archived) throw new DomainError("PROJECT_READ_ONLY", "项目已归档。", { status: 409 });
    return lookup(executor, projectId, userId);
  };
  await publish(context);
  const queued = await context.service.queueAnalysis(manager, input(), "archive-before-call");
  archived = true;
  const finished = await context.service.processAnalysisRun(queued.id);
  assert.equal(finished.status, "failed");
  assert.equal(finished.errorCode, "PROJECT_READ_ONLY");
  assert.equal(calls, 0);
  assert.equal((await context.repository.getRun(queued.id))!.status, "failed");
  assert.equal((await context.repository.getAnalysis(queued.analysisId))!.content, null);
});

test("archiving while a model runs rejects the late result and finishes the job", async () => {
  let began!: () => void;
  let finish!: (value: { content: AnalysisContent }) => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const deferred = new Promise<{ content: AnalysisContent }>(resolve => { finish = resolve; });
  let archived = false;
  const context = harness({ model: model(async () => { began(); return deferred; }) });
  const lookup = context.projectAccess.getMembershipForUpdate.bind(context.projectAccess);
  context.projectAccess.getMembershipForUpdate = async (executor, projectId, userId) => {
    if (archived) throw new DomainError("PROJECT_READ_ONLY", "项目已归档。", { status: 409 });
    return lookup(executor, projectId, userId);
  };
  await publish(context);
  const queued = await context.service.queueAnalysis(manager, input(), "archive-during-call");
  const processing = context.service.processAnalysisRun(queued.id);
  await started;
  archived = true;
  finish({ content: content() });
  const finished = await processing;
  assert.equal(finished.status, "failed");
  assert.equal(finished.errorCode, "PROJECT_READ_ONLY");
  assert.equal((await context.repository.getAnalysis(queued.analysisId))!.content, null);
});

test("crash recovery records a timeout and prevents an expired worker's late completion", async () => {
  let begin!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; });
  let finish!: (value: { content: AnalysisContent }) => void;
  const result = new Promise<{ content: AnalysisContent }>(resolve => { finish = resolve; });
  const context = harness({ model: model(async () => { begin(); return result; }), modelTimeoutMs: 1000 });
  await publish(context);
  const run = await context.service.queueAnalysis(manager, input(), "recover-crash");
  const worker = context.service.processAnalysisRun(run.id);
  await started;
  assert.equal((await context.service.recoverExpiredAnalysisRun(run.id)).status, "running");
  context.clock.advance(6001);
  const recovered = await context.service.recoverExpiredAnalysisRun(run.id);
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.errorCode, "MODEL_TIMEOUT");
  finish({ content: content() });
  assert.deepEqual(await worker, recovered);
  assert.equal(context.repository.inspect().analyses[0]!.content, null);
});

test("corrections are recorded separately from public rule evidence", async () => {
  const context = harness();
  await publish(context);
  const before = await context.service.getEvent("event-1");
  await assert.rejects(context.service.submitCorrection(member, "event-1", { field: "deadline", explanation: "链接更正", sourceUrl: "https://user:secret@example.test/rules" }), error("INVALID_URL"));
  const correction = await context.service.submitCorrection(member, "event-1", { field: "deadline", explanation: "请核查更新的截止时间", sourceUrl: "https://example.test/rules" });
  assert.equal(correction.status, "submitted");
  assert.equal(correction.rulesVersion, before.rules.version);
  assert.equal(correction.submittedBy, member.userId);
  assert.deepEqual(await context.service.getEvent("event-1"), before);
  assert.equal(context.repository.inspect().corrections.length, 1);
  assert.equal(context.repository.inspect().audits.at(-1)!.type, "EventCorrectionSubmitted");
});

test("test transactions roll back partial rules, records, and audits on failure", async () => {
  const repository = new MemoryEventsRepository();
  await assert.rejects(repository.transaction(async transaction => {
    await transaction.insertRules(rules());
    await transaction.saveEvent({ id: "event-1", revision: 1, publicationStatus: "draft", candidateVersion: 1, publishedVersion: null, lastVerifiedAt: null }, 0);
    await transaction.appendAudit({ id: "audit-1", type: "EventPublished", aggregateId: "event-1", projectId: null, version: 1, actorId: reviewer.userId, occurredAt: checkedAt, rulesEventId: "event-1", rulesVersion: 1 });
    throw new Error("simulated transaction failure");
  }), /simulated transaction failure/);
  const after = repository.inspect();
  assert.deepEqual(after.events, []);
  assert.deepEqual(after.rules, []);
  assert.deepEqual(after.audits, []);
  await repository.transaction(transaction => transaction.insertRules(rules()));
  assert.equal((await repository.getRules("event-1", 1))?.version, 1);
});
