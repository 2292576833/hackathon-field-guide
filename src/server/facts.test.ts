import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { Actor } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import { DomainError } from "../shared/errors.ts";
import { createDatabase } from "./database.ts";
import { createFactAdapters, confirmedRequirementVersionId } from "./facts.ts";
import { ProjectsService, PostgresProjectsRepository, createInvitationTokens } from "../modules/projects/index.ts";
import { EventsService, PostgresEventsRepository, type EventRuleVersion } from "../modules/events/index.ts";
import { AssessmentService, PostgresAssessmentRepository, PostgresQuestionCatalog, type AssignmentVersion } from "../modules/assessments/index.ts";
import { createPostgresPlanningRepository, createMemberAvailabilityValidator, type PlanningTask, type PlanVersion } from "../modules/planning/index.ts";
import { ResourceService, createPostgresResourceRepository, type Resource } from "../modules/resources/index.ts";
import { GitService, GitHubHttpAdapter, DeliveryService, PostgresGitRepositoryStore, PostgresDraftStore, PostgresDeliveryStore, type GitOperation } from "../modules/github/index.ts";
import type { EvidenceRef } from "../modules/retrospectives/index.ts";

const alice: Actor = { userId: "alice", platformRoles: ["user"] };
const outsider: Actor = { userId: "outsider", platformRoles: ["admin"] };
const reviewer: Actor = { userId: "reviewer", platformRoles: ["reviewer"] };
const now = "2026-10-08T02:00:00.000Z";

async function fixture() {
  const engine = await createDatabase({});
  await engine.migrate();
  const statements: string[] = [];
  let transactionCount = 0;
  const wrap = (sql: SqlExecutor): SqlExecutor => ({ query(statement, parameters) { statements.push(statement); return sql.query(statement, parameters); } });
  const database: DatabasePort = { query: wrap(engine).query, transaction: work => { transactionCount += 1; return engine.transaction(sql => work(wrap(sql))); } };
  for (const actor of [alice, outsider, reviewer]) await database.query("INSERT INTO auth_users(id,email,display_name,timezone,status,platform_roles,email_verified_at,created_at,revision) VALUES($1,$2,$1,'Asia/Shanghai','active',$3,$4,$4,1)", [actor.userId, `${actor.userId}@example.test`, actor.platformRoles, now]);
  const clock = { now: () => new Date(now) }; const ids = { next: () => randomUUID() };
  const projectRepository = new PostgresProjectsRepository(database);
  const eventsRepository = new PostgresEventsRepository(database);
  const assessmentRepository = new PostgresAssessmentRepository(database);
  const planningRepository = createPostgresPlanningRepository(database);
  const resourceRepository = createPostgresResourceRepository(database);
  let resources: ResourceService;
  const projects = new ProjectsService({ repository: projectRepository, clock, ids, tokens: createInvitationTokens(), availabilityValidator: createMemberAvailabilityValidator(projectRepository),
    resources: { async getReviewedResource(id, sql) { const resource = (await resources.getReviewedResources([id], sql))[0]; return resource ? { id, title: resource.name, version: resource.version } : null; } } });
  resources = new ResourceService({ repository: resourceRepository, reviews: { async getApprovedReview() { return null; } }, clock, ids, projectAccess: projectRepository, projectSharing: projects });
  const events = new EventsService({ repository: eventsRepository, projectAccess: projectRepository, projectWriteAccess: projectRepository, clock, ids });
  let facts: ReturnType<typeof createFactAdapters>;
  const assessments = new AssessmentService({ repository: assessmentRepository, catalog: new PostgresQuestionCatalog(database), projectAccess: projectRepository, assignmentContext: { getSnapshot: (...args) => facts.assignmentContext.getSnapshot(...args) }, clock, ids });
  const capabilities = { async getCapabilities() { return { saveRepository: false, verifyDelivery: true, recordSubmission: true }; } };
  const gitStore = new PostgresGitRepositoryStore(database);
  const git = new GitService({ access: projectRepository, capabilities, credentials: { async getUserCredential() { throw new Error("No external credentials in tests"); } }, github: new GitHubHttpAdapter(), store: gitStore, drafts: new PostgresDraftStore(database), clock, ids });
  const deliveryStore = new PostgresDeliveryStore(database);
  const delivery = new DeliveryService({ access: projectRepository, capabilities, store: deliveryStore, requirements: { assertConfirmed: input => facts.requirements.assertConfirmed(input) }, clock, ids });
  facts = createFactAdapters({ database, projectRepository, projects, eventsRepository, events, assessmentRepository, assessments, resources, planningRepository, git, delivery });
  const project = await projects.createProject(alice, { name: "真实引擎集成测试", timezone: "Asia/Shanghai", deadline: "2026-10-10T10:00:00+08:00" });
  return { engine, database, statements, transactionCount: () => transactionCount, projects, projectRepository, events, eventsRepository, assessmentRepository, assessments, planningRepository, resources, resourceRepository, gitStore, deliveryStore, delivery, facts, project };
}

function rules(): EventRuleVersion {
  const evidence = ["end", "requirement"].map(id => ({ id, eventId: "event", version: 1, sourceId: "official", fieldKey: id, excerpt: "核验测试证据", locator: `section-${id}`, rawDateText: id === "end" ? "2026-10-10 10:00:00" : null, verifiedBy: "reviewer", verifiedAt: now, conflictsWith: [] }));
  return { eventId: "event", version: 1, createdAt: now, metadata: { name: "测试赛事", organizer: "测试主办方", format: "online", region: "线上", officialUrl: "https://event.example.test/" },
    sources: [{ id: "official", eventId: "event", version: 1, sourceConfigId: null, url: "https://event.example.test/rules", kind: "official", contentHash: "a".repeat(64), fetchedAt: now, trustScope: "official_rules", status: "available" }],
    evidence, facts: ["eligibility", "fees", "team_size", "ai_policy"].map(key => ({ key, statement: "尚待确认", status: "unknown", evidenceIds: [] })),
    stages: [{ id: "submission", stageType: "submission", name: "作品提交", startsAt: null, endsAt: { rawText: "2026-10-10 10:00:00", timeZone: "Asia/Shanghai", utc: "2026-10-10T02:00:00.000Z", dateOnly: false, evidenceIds: ["end"] }, submissionUrl: "https://event.example.test/submit" }],
    requirements: [{ id: "repo", label: "作品仓库", necessity: "required", stageId: "submission", evidenceIds: ["requirement"] }], qualityFlags: ["missing_information"] };
}

async function confirm(f: Awaited<ReturnType<typeof fixture>>) {
  const snapshot = rules();
  await f.events.createCandidate(reviewer, snapshot, 0);
  await f.events.requestReview(reviewer, "event", 1);
  await f.events.publishCandidate(reviewer, "event", 2);
  return f.events.confirmProjectRules(alice, f.project.id, "event", 1, 0);
}

function resource(): Resource {
  return { id: "resource", name: "审核测试工具", officialUrl: "https://tool.example.test/", type: "practical_tool", stageTags: ["development"], useTags: ["development"], stackTags: ["stack_agnostic"], prerequisites: ["browse"], summary: "集成测试资料", suitableFor: "演示", notSuitableFor: "待验证", quickStart: ["阅读教程"], costType: "unknown", costNote: "无法确认", costSourceUrl: null, costVerifiedAt: null, licenseStatus: "unknown", licenseNote: "无法确认", licenseSourceUrl: null, licenseVerifiedAt: null, verifiedAt: now, linkStatus: "available", displayOrder: 1,
    version: 1, revision: 1, publicationStatus: "published", reviewId: "review", publishedAt: now, withdrawnReason: null, externalLinkBlocked: false, createdAt: now, updatedAt: now, recordedBy: reviewer.userId };
}

test("PGlite facts preserve unconfirmed manual deadlines and deny foreign project access", async () => {
  const f = await fixture();
  try {
    const input = await f.facts.planningFacts.readInput(f.project.id, now, alice);
    assert.equal(input.requirementVersionId, null); assert.equal(input.deadlines[0]?.verified, false);
    assert.equal(input.deadlines[0]?.id, "project-manual-target"); assert.ok(input.assumptions.some(item => item.includes("无法确认")));
    await assert.rejects(f.facts.planningFacts.readInput(f.project.id, now, outsider), (error: unknown) => error instanceof DomainError && error.status === 404);
    const head = await f.database.query("SELECT project_id FROM assessments_assignment_heads");
    assert.equal(head.rows.length, 0, "只读取规划依据不能初始化分工头");
    const context = await f.facts.assignmentContext.getSnapshot(f.project.id);
    assert.equal(context.members[0]?.userId, alice.userId); assert.equal(context.readOnly, false);
    await f.projects.transitionStage(alice, f.project.id, { expectedRevision: 1, stage: "archived", reason: "测试只读" });
    assert.equal((await f.facts.assignmentContext.getSnapshot(f.project.id)).readOnly, true);
    const archived = await f.database.transaction(sql => f.facts.planningFacts.lockVersions(f.project.id, sql, alice));
    assert.equal(archived.projectArchived, true); assert.equal(archived.projectReadOnly, true);
  } finally { await f.engine.close(); }
});

test("PGlite rules, requirement version, original-window validation and same-connection lock order agree", async () => {
  const f = await fixture();
  try {
    const confirmation = await confirm(f);
    await assert.rejects(f.projects.updateMyAvailability(alice, f.project.id, { expectedRevision: 0, timezone: "Asia/Shanghai", windows: [{ id: "bad", startsAt: "2026-10-09T10:00:00+07:00", endsAt: "2026-10-09T11:00:00+07:00", effectiveMinutes: 60 }] }), (error: unknown) => error instanceof DomainError && error.code === "INVALID_AVAILABILITY");
    const saved = await f.projects.updateMyAvailability(alice, f.project.id, { expectedRevision: 0, timezone: "Asia/Shanghai", windows: [{ id: "work", startsAt: "2026-10-09T10:00:00+08:00", endsAt: "2026-10-09T11:00:00+08:00", effectiveMinutes: 60 }] });
    const input = await f.facts.planningFacts.readInput(f.project.id, now, alice);
    assert.equal(input.requirementVersionId, confirmedRequirementVersionId(confirmation));
    assert.equal(input.deadlines.find(item => item.id === "submission")?.verified, true);
    assert.equal(input.requirements[0]?.deadlineRef, "submission"); assert.equal(input.requirements[0]?.mandatory, true);
    assert.equal(input.availability[0]?.windows[0]?.startsAt, "2026-10-09T02:00:00.000Z");
    assert.equal(input.availabilityVersions[input.members[0]!.membershipId], saved.availability.revision);
    f.statements.length = 0;
    const locked = await f.database.transaction(sql => f.facts.planningFacts.lockVersions(f.project.id, sql, alice));
    assert.equal(locked.requirementVersionId, input.requirementVersionId);
    const index = (fragment: string) => f.statements.findIndex(sql => sql.includes(fragment) && sql.includes("FOR UPDATE"));
    assert.ok(index("assessments_assignment_heads") >= 0);
    assert.ok(index("assessments_assignment_heads") < index("projects_project WHERE"));
    assert.ok(index("projects_project WHERE") < index("m03_project_rules"));
    const official = { projectId: f.project.id, eventId: "event", stageId: "submission", requirementsVersion: input.requirementVersionId!, platformUrl: "https://event.example.test/submit" };
    await f.facts.requirements.assertConfirmed(official);
    await assert.rejects(f.facts.requirements.assertConfirmed({ ...official, platformUrl: "https://attacker.example.test/submit" }), (error: unknown) => error instanceof DomainError && error.code === "SUBMISSION_PLATFORM_MISMATCH");
    const reconfirmed = await f.events.confirmProjectRules(alice, f.project.id, "event", 1, 1);
    assert.notEqual(confirmedRequirementVersionId(reconfirmed), official.requirementsVersion);
    await assert.rejects(f.facts.requirements.assertConfirmed(official), (error: unknown) => error instanceof DomainError && error.code === "REQUIREMENTS_NOT_CONFIRMED");
  } finally { await f.engine.close(); }
});

test("PGlite M09 share locks publication after project and persists one versioned reference", async () => {
  const f = await fixture();
  try {
    const live = resource(); await f.resourceRepository.insertRecord({ resource: live, publicResource: live });
    f.statements.length = 0;
    const command = { projectId: f.project.id, resourceId: live.id, resourceVersion: 1, purposeNote: "明确共享" };
    const saved = await f.resources.shareResource(alice, command);
    const lockIndex = (fragment: string) => f.statements.findIndex(sql => sql.includes(fragment) && sql.includes("FOR UPDATE"));
    assert.ok(lockIndex("projects_project WHERE") >= 0);
    assert.ok(lockIndex("projects_project WHERE") < lockIndex("resource_records"));
    assert.deepEqual(await f.resources.shareResource(alice, command), saved);
    const rows = await f.database.query<{ resource_version: number }>("SELECT resource_version FROM projects_resource_bookmark WHERE project_id=$1", [f.project.id]);
    assert.deepEqual(rows.rows, [{ resource_version: 1 }]);
    const updated = { ...live, version: 2, revision: 2 };
    await f.resourceRepository.saveRecord({ resource: updated, publicResource: updated }, 1);
    await assert.rejects(f.projects.addReviewedResource(alice, { ...command, title: "传入标题", url: live.officialUrl }), (error: unknown) => error instanceof DomainError && error.code === "RESOURCE_REFS_UNAVAILABLE");
    await f.projects.addReviewedResource(alice, { ...command, resourceVersion: 2, title: "不可信标题", url: live.officialUrl });
    assert.equal((await f.projects.listResources(alice, f.project.id))[0]?.resourceVersion, 2);
    assert.equal((await f.facts.planningFacts.readInput(f.project.id, now, alice)).approvedResourceIds[0], live.id);
  } finally { await f.engine.close(); }
});

test("PGlite all eight evidence types enforce project/version/current visibility and return only metadata", async () => {
  const f = await fixture();
  try {
    const confirmation = await confirm(f); const requirementVersion = confirmedRequirementVersionId(confirmation);
    const input = await f.facts.planningFacts.readInput(f.project.id, now, alice);
    const task: PlanningTask = { id: "task", projectId: f.project.id, title: "私密任务标题", priority: "must", kind: "implementation", ownerMembershipId: input.members[0]!.membershipId, helperEfforts: [], deliverable: "私密交付描述", acceptanceCriteria: ["私密验收"], reviewerMembershipId: null, durationEstimate: { optimisticMinutes: 10, likelyMinutes: 20, pessimisticMinutes: 30, basis: "测试" }, remainingEstimate: null, dependencyTaskIds: [], deadlineRef: "submission", requirementRefs: [], resourceRefs: [], splittable: false, contextSwitchMinutes: 0, waitMinutes: 0, status: "todo", blocker: null, cancellationReason: null, acceptance: null, revision: 1, updatedAt: now };
    const plan: PlanVersion = { id: "plan", projectId: f.project.id, basePlanVersionId: null, baseTasksRevision: 0, inputSnapshot: input, tasks: [task], buffers: [], validation: null, changes: [], status: "draft", reason: "测试", createdBy: alice.userId, createdAt: now, appliedBy: null, appliedAt: null, acknowledgedIssueCodes: [], revision: 1 };
    await f.planningRepository.transaction(f.project.id, async (state, transaction) => { await transaction.save({ ...state, tasks: [task], plans: [plan], revision: 1 }, 0); });
    const context = await f.facts.assignmentContext.getSnapshot(f.project.id);
    const assignment: AssignmentVersion = { id: "assignment", projectId: f.project.id, baseVersionId: null, inputSnapshot: { ...context, sharedSummaryRefs: [] }, assignments: [], gaps: [], assumptions: [], changes: [], validationIssues: [], status: "draft", revision: 1, createdBy: alice.userId, createdAt: now, updatedAt: now, appliedBy: null, appliedAt: null };
    await f.assessmentRepository.transaction(transaction => transaction.saveAssignment(assignment, null));
    const currentAssignment = await f.database.transaction(sql => f.facts.finalFactsLock.lock({ actor: alice, operation: "retrospective.confirm", projectIds: [f.project.id], evidence: [{ projectId: f.project.id, audience: "project", refs: [{ kind: "assignment", id: "assignment", revision: 1 }] }], resourceIds: [] }, sql));
    assert.equal(currentAssignment.evidence[0]?.states[0]?.state, "available", "JSONB property order must not make an unchanged assignment stale");
    const operation: GitOperation = { id: "save", projectId: f.project.id, actorId: alice.userId, bindingId: "binding", bindingRevision: 1, target: { repositoryId: 1, owner: "private-owner", name: "private-repo", installationId: 1, appId: 1, defaultBranch: "main" }, idempotencyKey: "save", inputHash: "a".repeat(64), manifest: { entries: [], totalBytes: 0, inputHash: "a".repeat(64), issues: [] }, draftRef: "private-file", expiresAt: now, message: "私密提交信息", wantsPullRequest: false, branch: "private-branch", status: "saved", step: "done", revision: 1, createdAt: now, updatedAt: now, preview: null, treeSha: null, commitSha: "b".repeat(40), commitMessage: null, pullRequestUrl: null, pullRequestStatus: "not_requested", errorCode: null, leaseUntil: null };
    await f.gitStore.createOperation(operation);
    await f.deliveryStore.insertVerification({ id: "verification", projectId: f.project.id, repositoryCommitSha: null, verifierId: alice.userId, verifiedAt: now, environmentSummary: "私密环境", steps: ["私密操作"], outcome: "passed", blockers: [], evidenceRefs: ["private-evidence"], verificationSource: "user_reported", version: 1 });
    await f.deliveryStore.insertSubmission({ id: "submission-record", projectId: f.project.id, eventId: "event", stageId: "submission", requirementsVersion: requirementVersion, platformUrl: "https://event.example.test/submit", submittedAt: now, verificationSource: "user_reported", repositoryCommitSha: null, status: "reported", evidenceRefs: ["private-evidence"], recordedBy: alice.userId, recordedAt: now, version: 1 });
    const shared = await f.projects.addResource(alice, f.project.id, { expectedRevision: f.project.revision, url: "https://private-reference.example.test", title: "私密成员标题", purposeNote: "私密备注" });
    const refs: EvidenceRef[] = [{ kind: "rule", id: "event", revision: 1 }, { kind: "plan", id: "plan", revision: 1 }, { kind: "task", id: "task", revision: 1 }, { kind: "assignment", id: "assignment", revision: 1 }, { kind: "git_save", id: "save", revision: 1 }, { kind: "delivery_verification", id: "verification", revision: 1 }, { kind: "submission", id: "submission-record", revision: 1 }, { kind: "project_resource", id: shared.bookmark.id, revision: 1 }];
    const states = await f.facts.evidence.resolve(alice, f.project.id, refs, "project");
    assert.equal(states.length, 8); assert.ok(states.every(item => item.state === "available" || item.state === "outdated"));
    assert.ok(states.every(item => item.projectShareable));
    const serialized = JSON.stringify(states);
    for (const privateValue of ["私密", "private-owner", "private-evidence", "private-reference", "private-file"]) assert.ok(!serialized.includes(privateValue));
    const final = await f.database.transaction(sql => f.facts.finalFactsLock.lock({ actor: alice, operation: "retrospective.confirm", projectIds: [f.project.id], evidence: [{ projectId: f.project.id, audience: "project", refs }], resourceIds: [] }, sql));
    assert.equal(final.evidence[0]?.states.length, 8);
    assert.ok(final.evidence[0]?.states.every(item => ["available", "outdated"].includes(item.state)));
    for (const privateValue of ["私密", "private-owner", "private-evidence", "private-reference", "private-file"]) assert.ok(!JSON.stringify(final).includes(privateValue));
    assert.equal((await f.facts.evidence.resolve(alice, f.project.id, [{ kind: "task", id: "task", revision: 2 }], "personal"))[0]?.state, "outdated");
    assert.ok((await f.facts.evidence.resolve(outsider, f.project.id, refs, "project")).every(item => item.state === "unavailable" && !item.projectShareable));
    const previousSubmission = await f.deliveryStore.getSubmission(f.project.id, "submission-record");
    assert.ok(previousSubmission);
    await f.deliveryStore.updateSubmission({ ...previousSubmission, version: 2, status: "rejected_or_withdrawn", submittedAt: null }, 1);
    const currentSubmission = await f.database.transaction(sql => f.facts.finalFactsLock.lock({ actor: alice, operation: "retrospective.confirm", projectIds: [f.project.id], evidence: [{ projectId: f.project.id, audience: "project", refs: [refs[6]!] }], resourceIds: [] }, sql));
    assert.equal(currentSubmission.evidence[0]?.states[0]?.state, "withdrawn", "an older reported version cannot override the current withdrawn head");
    await f.projects.removeResource(alice, f.project.id, shared.bookmark.id, shared.projectRevision);
    assert.equal((await f.facts.evidence.resolve(alice, f.project.id, [refs[7]!], "personal"))[0]?.state, "withdrawn");
    const secondProject = await f.projects.createProject(alice, { name: "另一个项目", timezone: "Asia/Shanghai" });
    assert.ok((await f.facts.evidence.resolve(alice, secondProject.id, refs, "project")).every(item => item.state === "unavailable"));
  } finally { await f.engine.close(); }
});

test("PGlite final write guard uses only supplied executor and rereads anonymous/revoked/archive/withdrawn facts", async () => {
  const f = await fixture();
  try {
    const live = resource(); await f.resourceRepository.insertRecord({ resource: live, publicResource: live });
    const saved = await f.projects.addReviewedResource(alice, { projectId: f.project.id, resourceId: live.id, resourceVersion: live.version, title: "不可信标题", url: live.officialUrl, purposeNote: "集成测试" });
    const refs: EvidenceRef[] = [{ kind: "project_resource", id: saved.id, revision: 1 }];
    const request = { actor: alice, operation: "retrospective.confirm" as const, projectIds: [f.project.id], evidence: [{ projectId: f.project.id, audience: "project" as const, refs }], resourceIds: [live.id] };
    const before = f.transactionCount();
    const initial = await f.database.transaction(sql => f.facts.finalFactsLock.lock(request, sql));
    assert.equal(f.transactionCount(), before + 1, "final lock must not create nested transactions");
    assert.equal(initial.projects[0]?.membership?.status, "active"); assert.equal(initial.projects[0]?.archived, false);
    assert.deepEqual(initial.reviewedResourceIds, [live.id]); assert.equal(initial.evidence[0]?.states[0]?.state, "available");
    await assert.rejects(f.database.transaction(sql => f.facts.finalFactsLock.lock({ ...request, actor: { userId: "", platformRoles: [] } }, sql)), (error: unknown) => error instanceof DomainError && error.status === 401);
    await f.database.query("UPDATE auth_users SET status='suspended' WHERE id=$1", [alice.userId]);
    await assert.rejects(f.database.transaction(sql => f.facts.finalFactsLock.lock(request, sql)), (error: unknown) => error instanceof DomainError && error.status === 401);
    await f.database.query("UPDATE auth_users SET status='active' WHERE id=$1", [alice.userId]);
    const withdrawn = { ...live, publicationStatus: "withdrawn" as const, withdrawnReason: "下架测试", externalLinkBlocked: true, revision: 2 };
    await f.resourceRepository.saveRecord({ resource: withdrawn, publicResource: withdrawn }, 1);
    const unpublished = await f.database.transaction(sql => f.facts.finalFactsLock.lock(request, sql));
    assert.deepEqual(unpublished.reviewedResourceIds, []); assert.equal(unpublished.evidence[0]?.states[0]?.state, "withdrawn");
    let revision = await f.projectRepository.withProject(f.project.id, async aggregate => aggregate.project.revision);
    const invitation = await f.projects.createProjectInvitation(alice, f.project.id, { expectedRevision: revision, role: "manager" });
    await f.projects.acceptInvitation(outsider, invitation.token);
    revision = await f.projectRepository.withProject(f.project.id, async aggregate => aggregate.project.revision);
    await f.projects.transitionStage(alice, f.project.id, { expectedRevision: revision, stage: "archived", reason: "归档后拒绝写入" });
    const archived = await f.database.transaction(sql => f.facts.finalFactsLock.lock(request, sql));
    assert.equal(archived.projects[0]?.archived, true);
    revision = await f.projectRepository.withProject(f.project.id, async aggregate => aggregate.project.revision);
    await f.projects.removeProjectMember(outsider, f.project.id, alice.userId, revision);
    const revoked = await f.database.transaction(sql => f.facts.finalFactsLock.lock(request, sql));
    assert.equal(revoked.projects[0]?.membership?.status, "removed");
    assert.equal(revoked.evidence[0]?.states[0]?.state, "unavailable");
    assert.equal(revoked.evidence[0]?.states[0]?.projectShareable, false);
  } finally { await f.engine.close(); }
});
