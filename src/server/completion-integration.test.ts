import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import type { TestContext } from "node:test";
import type { Actor } from "../shared/contracts.ts";
import type { AccountDataOverview, AccountDeletionSummary, DataExportSummary, EmailChangeReceipt, EmailChangeResult, OwnDataDocument } from "../modules/auth/index.ts";
import type { Project, ProjectMember, MyIntentionView } from "../modules/projects/index.ts";
import type { EventRuleVersion } from "../modules/events/index.ts";
import type { DeliveryMaterialsView, DeliveryMaterialChecklist, DeliveryMaterialsSummary, SaveDeliveryMaterialsInput, GitOperation } from "../modules/github/index.ts";
import { PostgresGitRepositoryStore } from "../modules/github/index.ts";
import type { AuditQueryPage } from "../modules/operations/audit-query-types.ts";
import type { Correction } from "../modules/operations/correction-types.ts";
import type { ExperienceCard, ReuseDraft } from "../modules/retrospectives/domain.ts";
import type { ReuseDraftView, DocumentView } from "../modules/retrospectives/service.ts";
import type { EditDraftPage, EditDraftSaveInput, EditDraftSaveResult, RetrospectiveEditDraft } from "../modules/retrospectives/edit-drafts.ts";
import type { OwnPlanningNotification } from "../modules/planning/notification-types.ts";
import type { TaskProposal } from "../modules/planning/index.ts";
import { AGENT_IDS, INITIAL_SKILLS, hash } from "../modules/skills/index.ts";
import type { ProjectSkillSelectionState, ProjectSkillSelectionView, ReviewedSkillOption, SkillCandidate, SkillCandidateDocument, SkillCandidateEvidence, SkillReviewSnapshot, TaskSkillReference } from "../modules/skills/index.ts";
import type { SkillReview } from "../modules/operations/skill-review.ts";
import type { SourceObservabilityReport } from "../modules/operations/observability-types.ts";
import type { ResourceLinkMaintenanceStatus } from "./resource-link-maintenance.ts";
import { createDatabase } from "./database.ts";
import { createApplication } from "./application.ts";
import { dispatch } from "./router.ts";

const origin = "http://localhost:3000";
type Identity = { actor: Actor; cookie: string; sessionId: string };
type Envelope<T> = { data: T; error?: { code: string; message: string; latestRevision?: number } };

/** Own in-memory PGlite and explicit config: never loads .env, a private directory or workers. */
async function fixture(context: TestContext) {
  const originalFetch = globalThis.fetch;
  let outboundCalls = 0;
  globalThis.fetch = async () => { outboundCalls++; throw new Error("Isolated completion test forbids external network"); };
  const database = await createDatabase({});
  context.after(async () => { await database.close(); globalThis.fetch = originalFetch; assert.equal(outboundCalls, 0); });
  const app = await createApplication({ mode: "local", origin, codePepper: "completion-integration-fixture-only-32bytes", emailFrom: "fixture@localhost.invalid" }, database);
  const now = app.clock.now().toISOString();
  const seed = async (userId: string, platformRoles: Actor["platformRoles"] = ["user"]): Promise<Identity> => {
    await database.query("INSERT INTO auth_users(id,email,display_name,timezone,status,platform_roles,email_verified_at,created_at,revision) VALUES($1,$2,$1,'Asia/Shanghai','active',$3,$4,$4,1)", [userId, `${userId}@example.test`, [...platformRoles], now]);
    const token = randomBytes(32).toString("base64url"); const sessionId = `${userId}-session`;
    await database.query("INSERT INTO auth_sessions(id,user_id,token_hash,created_at,authenticated_at,expires_at) VALUES($1,$2,$3,$4,$4,$5)", [sessionId, userId, createHash("sha256").update(token).digest("hex"), now, new Date(app.clock.now().getTime() + 3600000).toISOString()]);
    return { actor: { userId, platformRoles }, cookie: `hackathon_session=${token}`, sessionId };
  };
  const owner = await seed("completion-owner"), member = await seed("completion-member"), outsider = await seed("completion-outsider"), admin = await seed("completion-admin", ["admin", "reviewer"]);
  return { app, database, owner, member, outsider, admin };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function request<T = unknown>(f: Fixture, identity: Identity | null, path: string, method = "GET", body?: unknown, expectedStatus = 200, requestOrigin = origin) {
  const headers = new Headers({ origin: requestOrigin, "content-type": "application/json" });
  if (identity) headers.set("cookie", identity.cookie);
  const response = await dispatch(f.app, new Request(`${origin}/api/v1/${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), path.split("?", 1)[0]!.split("/"));
  const envelope = await response.json() as Envelope<T>;
  // Never put cookies, challenge codes, private draft bodies or invitation tokens in a failure.
  assert.equal(response.status, expectedStatus, `${method} completion route: ${envelope.error?.code ?? "success"}`);
  return { ...envelope, response };
}
async function project(f: Fixture, who = f.owner) {
  return (await request<Project>(f, who, "projects", "POST", { name: "隔离完整参赛空间", timezone: "Asia/Shanghai", goal: "做可演示的最小作品" }, 201)).data;
}
async function revision(f: Fixture, id: string) { return (await request<{ project: Project }>(f, f.owner, `projects/${id}`)).data.project.revision; }
async function join(f: Fixture, p: Project, who = f.member, maxUses = 3) {
  const invitation = (await request<{ token: string; invitation: { id: string } }>(f, f.owner, `projects/${p.id}/invitations`, "POST", { expectedRevision: await revision(f, p.id), maxUses }, 201)).data;
  const accepted = (await request<{ membership: ProjectMember }>(f, who, `invitations/${invitation.token}/accept`, "POST")).data;
  return { invitation, accepted };
}
async function materialRows(f: Fixture) {
  return {
    current: (await f.database.query("SELECT * FROM m06_delivery_material_heads ORDER BY project_id")).rows,
    history: (await f.database.query("SELECT * FROM m06_delivery_material_versions ORDER BY project_id,version")).rows,
    events: (await f.database.query("SELECT * FROM m06_delivery_material_events ORDER BY id")).rows,
  };
}
function rules(f: Fixture, eventId: string, version = 1): EventRuleVersion {
  const now = f.app.clock.now().toISOString();
  return { eventId, version, createdAt: now,
    metadata: { name: "隔离官方材料赛事", organizer: "夹具主办方", format: "online", region: "线上", officialUrl: "https://example.test/rules" },
    sources: [{ id: "official", eventId, version, sourceConfigId: null, url: "https://example.test/rules", kind: "official", contentHash: "a".repeat(64), fetchedAt: now, trustScope: "official_rules", status: "available" }],
    evidence: [{ id: "demo-proof", eventId, version, sourceId: "official", fieldKey: "requirements", excerpt: "提交可演示版本与说明文档。", locator: "#materials", rawDateText: null, verifiedBy: f.admin.actor.userId, verifiedAt: now, conflictsWith: [] }],
    facts: ["eligibility", "fees", "team_size", "ai_policy"].map(key => ({ key, statement: "待主办方核对", status: "unknown", evidenceIds: [] })),
    stages: [], requirements: [{ id: "demo", label: version === 1 ? "可演示版本" : "新版演示材料", necessity: "required", stageId: null, evidenceIds: ["demo-proof"] }], qualityFlags: ["missing_information"] };
}
async function publishRules(f: Fixture, eventId: string) {
  await f.app.events.createCandidate(f.admin.actor, rules(f, eventId), 0);
  await f.app.events.requestReview(f.admin.actor, eventId, 1);
  await f.app.events.publishCandidate(f.admin.actor, eventId, 2);
}
async function confirmRules(f: Fixture, p: Project, eventId: string, expectedRevision = 0) {
  await request(f, f.owner, `projects/${p.id}/rules/confirm`, "POST", { eventId, rulesVersion: 1, expectedRevision });
  return (await request<DeliveryMaterialsView>(f, f.owner, `projects/${p.id}/delivery-materials`)).data;
}
function materialsInput(view: DeliveryMaterialsView, now: string, key: string, expectedVersion: number | null = null): SaveDeliveryMaterialsInput {
  assert.ok(view.requirements);
  return { expectedVersion, eventId: view.requirements.eventId, requirementsVersion: view.requirements.requirementsVersion,
    repositoryCommitSha: "b".repeat(40), entries: [{ requirementId: "demo", location: "https://example.test/demo", revision: "demo-v1", repositoryCommitSha: "b".repeat(40),
      verification: { outcome: "passed", verifiedAt: now, evidenceRefs: ["fixture-demo-check"], note: "夹具成员自报，非真实平台验收", verificationSource: "user_reported" } }], branchVerification: null, idempotencyKey: key };
}
async function savedCommit(f: Fixture, p: Project) {
  const at = f.app.clock.now().toISOString();
  const operation: GitOperation = { id: "fixture-saved-operation", projectId: p.id, actorId: f.owner.actor.userId, bindingId: "fixture-binding", bindingRevision: 1,
    target: { repositoryId: 1, owner: "fixture", name: "isolated-demo", installationId: 2, appId: 3, defaultBranch: "main" },
    idempotencyKey: "fixture-saved-commit", inputHash: "fixture-manifest", manifest: { entries: [], totalBytes: 0, inputHash: "fixture-manifest", issues: [] },
    draftRef: "fixture-draft", expiresAt: new Date(f.app.clock.now().getTime() + 3600000).toISOString(), message: "隔离夹具保存事实", wantsPullRequest: false,
    branch: "hackathon/fixture", status: "saved", step: "done", revision: 1, createdAt: at, updatedAt: at, preview: null, treeSha: "c".repeat(40), commitSha: "b".repeat(40), commitMessage: null,
    pullRequestUrl: null, pullRequestStatus: "not_requested", errorCode: null, leaseUntil: null };
  await new PostgresGitRepositoryStore(f.database).createOperation(operation);
}

test("root migration 032 and explicit accept preserve actual membership association; archived DELETE is entirely read-only", async context => {
  const f = await fixture(context); const p = await project(f); const { invitation, accepted } = await join(f, p);
  const rows = await f.database.query<{ membership_id: string }>("SELECT membership_id FROM projects_invitation_acceptance WHERE invitation_id=$1 AND user_id=$2", [invitation.invitation.id, f.member.actor.userId]);
  assert.equal(rows.rows[0]?.membership_id, accepted.membership.membershipId);
  assert.equal((await request(f, f.member, `invitations/${invitation.token}/accept`, "POST")).response.ok, true);
  assert.equal((await f.database.query("SELECT * FROM projects_invitation_acceptance WHERE invitation_id=$1", [invitation.invitation.id])).rowCount, 1);
  const aggregate = async () => f.database.transaction(async tx => ({
    project: (await tx.query("SELECT * FROM projects_project WHERE id=$1", [p.id])).rows,
    invites: (await tx.query("SELECT * FROM projects_invitation WHERE scope_id=$1", [p.id])).rows,
    audit: (await tx.query("SELECT * FROM projects_activity WHERE project_id=$1 ORDER BY id", [p.id])).rows,
    facts: (await tx.query("SELECT * FROM projects_change_fact WHERE project_id=$1 ORDER BY event_id", [p.id])).rows,
  }));
  await request(f, f.owner, `projects/${p.id}/stage`, "POST", { expectedRevision: await revision(f, p.id), stage: "archived", reason: "保留原接受事实" });
  const before = await aggregate();
  const denied = await request(f, f.owner, `projects/${p.id}/invitations/${invitation.invitation.id}`, "DELETE", { expectedRevision: await revision(f, p.id) }, 409);
  assert.equal(denied.error?.code, "PROJECT_ARCHIVED"); assert.deepEqual(await aggregate(), before);
  await request(f, f.outsider, `projects/${p.id}/invitations/${invitation.invitation.id}`, "DELETE", { expectedRevision: await revision(f, p.id) }, 404);
  await f.database.query("UPDATE auth_sessions SET revoked_at=now() WHERE id=$1", [f.owner.sessionId]);
  await request(f, f.owner, `projects/${p.id}/invitations/${invitation.invitation.id}`, "DELETE", { expectedRevision: 1 }, 401);
  assert.deepEqual(await aggregate(), before);
});

test("root confirmed rules produce real material history and summaries while runtime/submission and required branch stay independent", async context => {
  const f = await fixture(context); const p = await project(f); await join(f, p); await publishRules(f, "completion-material-event");
  assert.equal((await request<DeliveryMaterialsView>(f, f.owner, `projects/${p.id}/delivery-materials`)).data.requirements, null);
  const view = await confirmRules(f, p, "completion-material-event"); assert.equal(view.requirements?.materials[0]?.label, "可演示版本");
  assert.equal(view.requirements?.requiredBranch.status, "unknown");
  await savedCommit(f, p);
  const input = materialsInput(view, f.app.clock.now().toISOString(), "root-material-first");
  const record = (await request<DeliveryMaterialChecklist>(f, f.owner, `projects/${p.id}/delivery-materials`, "PUT", input)).data;
  assert.equal(record.version, 1); assert.equal(record.entries[0]?.verification?.verifiedBy, f.owner.actor.userId);
  assert.deepEqual((await request<DeliveryMaterialChecklist[]>(f, f.member, `projects/${p.id}/delivery-materials/history`)).data.map(item => item.version), [1]);
  const summary = (await request<{ requirements: DeliveryMaterialsSummary; runtime: { status: string }; submission: { records: unknown[] } }>(f, f.owner, `projects/${p.id}/delivery-summary`)).data;
  assert.equal(summary.requirements.materials[0]?.status, "prepared"); assert.equal(summary.requirements.branch.status, "unknown");
  assert.equal(summary.requirements.status, "unknown"); assert.equal(summary.runtime.status, "not_verified"); assert.deepEqual(summary.submission.records, []);
  assert.equal((await f.app.retrospectives.deliverySummary(f.owner.actor, p.id)).materials[0]?.status, "prepared", "M07 reads the M06 checklist, without copying a second completion state");
  const before = await materialRows(f);
  assert.equal((await request(f, f.owner, `projects/${p.id}/delivery-materials`, "PUT", { ...input, idempotencyKey: "root-material-stale" }, 409)).error?.code, "VERSION_CONFLICT");
  assert.equal((await request(f, f.owner, `projects/${p.id}/delivery-materials`, "PUT", { ...input, expectedVersion: 1, requirementsVersion: "different-confirmation", idempotencyKey: "root-material-bad-rules" }, 409)).error?.code, "REQUIREMENTS_VERSION_CONFLICT");
  await request(f, f.member, `projects/${p.id}/delivery-materials`, "PUT", { ...input, expectedVersion: 1 }, 403);
  for (const suffix of ["delivery-materials", "delivery-materials/history", "delivery-summary"]) {
    await request(f, f.outsider, `projects/${p.id}/${suffix}`, "GET", undefined, 404);
    await request(f, null, `projects/${p.id}/${suffix}`, "GET", undefined, 401);
  }
  assert.deepEqual(await materialRows(f), before);
  await request(f, f.owner, `projects/${p.id}/stage`, "POST", { expectedRevision: await revision(f, p.id), stage: "archived", reason: "保留材料清单历史" });
  await request(f, f.owner, `projects/${p.id}/delivery-materials`, "GET"); await request(f, f.member, `projects/${p.id}/delivery-materials/history`);
  assert.equal((await request(f, f.owner, `projects/${p.id}/delivery-materials`, "PUT", { ...input, expectedVersion: 1, idempotencyKey: "root-material-archived" }, 409)).error?.code, "PROJECT_ARCHIVED");
  await f.database.query("UPDATE auth_sessions SET revoked_at=now() WHERE id=$1", [f.owner.sessionId]);
  for (const suffix of ["delivery-materials", "delivery-materials/history", "delivery-summary"]) await request(f, f.owner, `projects/${p.id}/${suffix}`, "GET", undefined, 401);
  assert.deepEqual(await materialRows(f), before);
});

test("root rejects a session revoked after material persistence and rolls the entire request back", async context => {
  const f = await fixture(context); const p = await project(f); await publishRules(f, "completion-revoke-event");
  const view = await confirmRules(f, p, "completion-revoke-event");
  const original = f.app.deliveryMaterials.save.bind(f.app.deliveryMaterials);
  f.app.deliveryMaterials.save = async (...args) => {
    const result = await original(...args);
    await f.database.query("UPDATE auth_sessions SET revoked_at=now() WHERE id=$1", [f.owner.sessionId]);
    return result;
  };
  const before = await materialRows(f);
  await request(f, f.owner, `projects/${p.id}/delivery-materials`, "PUT", materialsInput(view, f.app.clock.now().toISOString(), "root-material-revoked-late"), 401);
  assert.deepEqual(await materialRows(f), before);
  assert.equal((await f.database.query<{ revoked_at: unknown }>("SELECT revoked_at FROM auth_sessions WHERE id=$1", [f.owner.sessionId])).rows[0]?.revoked_at, null, "the rejected ambient transaction also rolls back the injected fixture revocation");
});

test("root rejects a session revoked after private experience persistence and rolls back its document and audit", async context => {
  const f = await fixture(context); const p = await project(f);
  const original = f.app.retrospectives.createExperienceCard.bind(f.app.retrospectives);
  f.app.retrospectives.createExperienceCard = async (...args) => {
    const result = await original(...args);
    await f.database.query("UPDATE auth_sessions SET revoked_at=now() WHERE id=$1", [f.owner.sessionId]);
    return result;
  };
  const snapshot = async () => ({ documents: (await f.database.query("SELECT * FROM m07_documents ORDER BY id")).rows, versions: (await f.database.query("SELECT * FROM m07_document_versions ORDER BY document_id,revision")).rows, audit: (await f.database.query("SELECT * FROM m07_audit_events ORDER BY id")).rows });
  const before = await snapshot();
  await request(f, f.owner, `projects/${p.id}/experience-cards`, "POST", { scope: "personal", content: { title: "保留经验", scenario: "演示前整理", advice: ["提前列出材料"], conditions: "小队演示", limitations: "仍需核对规则", evidenceRefs: [], tools: [] } }, 401);
  assert.deepEqual(await snapshot(), before);
  assert.equal((await f.database.query<{ revoked_at: unknown }>("SELECT revoked_at FROM auth_sessions WHERE id=$1", [f.owner.sessionId])).rows[0]?.revoked_at, null);
});

test("root corrections persist station responses and audit exposes metadata only with cursor and current-admin checks", async context => {
  const f = await fixture(context); await publishRules(f, "completion-correction-event");
  const correction = (await request<Correction>(f, f.owner, "corrections", "POST", { target: { kind: "event", entityId: "completion-correction-event", version: 1 }, field: "materials", message: "PRIVATE_CORRECTION_BODY 请核对材料要求。", evidenceUrls: ["https://example.test/evidence"] }, 201)).data;
  await request(f, f.member, `me/corrections/${correction.id}`, "GET", undefined, 404);
  await request(f, f.member, `admin/corrections/${correction.id}`, "GET", undefined, 403);
  const triage = (await request<Correction>(f, f.admin, `admin/corrections/${correction.id}`, "PATCH", { expectedRevision: 1, status: "triaging", reason: "PRIVATE_REVIEW_REASON 进入核查。" })).data;
  const denied = await request(f, f.admin, `admin/corrections/${correction.id}`, "PATCH", { expectedRevision: 1, status: "confirmed", reason: "不应用旧版本" }, 409);
  assert.equal(denied.error?.code, "VERSION_CONFLICT");
  await request(f, f.admin, `admin/corrections/${correction.id}`, "PATCH", { expectedRevision: triage.revision, status: "confirmed", reason: "已核对，需要补充公开说明。" });
  const own = (await request<Correction>(f, f.owner, `me/corrections/${correction.id}`)).data;
  assert.equal(own.status, "confirmed"); assert.equal(own.response, "已核对，需要补充公开说明。");
  const path = `admin/operations/audit?stream=correction&objectId=${correction.id}&limit=1`;
  const first = (await request<AuditQueryPage>(f, f.admin, path)).data;
  assert.equal(first.items.length, 1); assert.ok(first.nextCursor);
  const next = (await request<AuditQueryPage>(f, f.admin, `${path}&cursor=${encodeURIComponent(first.nextCursor!)}`)).data;
  assert.equal(next.items.length, 1); assert.notEqual(first.items[0]?.id, next.items[0]?.id); assert.equal(next.nextCursor, null);
  for (const item of [...first.items, ...next.items]) assert.deepEqual(Object.keys(item).sort(), ["action", "actorId", "actorKind", "contentVersion", "id", "objectId", "objectKind", "occurredAt", "revision", "stream"].sort());
  assert.equal(JSON.stringify(first).includes("PRIVATE_"), false); assert.equal(JSON.stringify(next).includes("example.test"), false);
  await request(f, f.admin, `${path}&cursor=${encodeURIComponent(first.nextCursor!.slice(0, -1) + "!")}`, "GET", undefined, 400);
  await request(f, f.admin, `${path}&unknownFilter=value`, "GET", undefined, 400);
  await request(f, f.member, path, "GET", undefined, 403); await request(f, null, path, "GET", undefined, 401);
  await f.database.query("UPDATE auth_users SET platform_roles=ARRAY['user']::text[],revision=revision+1 WHERE id=$1", [f.admin.actor.userId]);
  await request(f, f.admin, path, "GET", undefined, 403);
  await f.database.query("UPDATE auth_users SET platform_roles=ARRAY['admin']::text[],revision=revision+1 WHERE id=$1", [f.admin.actor.userId]);
  await f.database.query("UPDATE auth_sessions SET revoked_at=now() WHERE id=$1", [f.admin.sessionId]);
  await request(f, f.admin, path, "GET", undefined, 401);
});

test("root experience library keeps personal cards and selective reuse private across scope, archive and membership changes", async context => {
  const f = await fixture(context); const source = await project(f); await join(f, source); const target = await project(f); await join(f, target);
  const content = { title: "提前准备材料", scenario: "临近演示才整理素材", advice: ["先列出真实必交材料"], conditions: "适用于小队原型", limitations: "仍须核对当次主办方要求", evidenceRefs: [], tools: [] };
  const personal = (await request<ExperienceCard>(f, f.owner, `projects/${source.id}/experience-cards`, "POST", { scope: "personal", content }, 201)).data;
  const shared = (await request<ExperienceCard>(f, f.owner, `projects/${source.id}/experience-cards`, "POST", { scope: "project", content: { ...content, title: "空间共享经验" } }, 201)).data;
  const confirmed = (await request<ExperienceCard>(f, f.owner, `experience-cards/${personal.id}/confirm`, "POST", { expectedRevision: 1 })).data;
  assert.equal(confirmed.revision, 2);
  const cards = (await request<{ items: DocumentView<ExperienceCard>[] }>(f, f.owner, "experience-cards?query=提前&status=confirmed")).data.items;
  assert.deepEqual(cards.map(item => item.id), [personal.id]); assert.ok(!cards.some(item => item.id === shared.id));
  assert.deepEqual((await request<{ items: unknown[] }>(f, f.member, "experience-cards")).data.items, []);
  assert.deepEqual((await request<{ items: unknown[] }>(f, f.owner, "retrospectives")).data.items, []);
  const historical = (await request<DocumentView<ExperienceCard>>(f, f.owner, `experience-cards/${personal.id}/history?revision=1`)).data;
  assert.equal(historical.document?.status, "draft");
  await request(f, f.member, `experience-cards/${personal.id}/history?revision=1`, "GET", undefined, 404);
  const reuseInput = { sourceCardId: personal.id, sourceRevision: confirmed.revision, selectedFields: ["advice", "conditions"], acknowledgeRechecks: true };
  const reuse = (await request<ReuseDraft>(f, f.owner, `projects/${target.id}/experience-reuses`, "POST", reuseInput, 201)).data;
  const selected = (await request<ReuseDraftView>(f, f.owner, `experience-reuses/${reuse.id}`)).data;
  assert.deepEqual(selected.selectedContent, { advice: content.advice, conditions: content.conditions });
  assert.ok(selected.requiredRechecks.length >= 5); assert.equal(reuse.scope, "personal");
  const targetList = (await request<{ items: ReuseDraftView[] }>(f, f.owner, `projects/${target.id}/experience-reuses`)).data;
  assert.equal(targetList.items[0]?.draft.id, reuse.id);
  await request(f, f.member, `experience-reuses/${reuse.id}`, "GET", undefined, 404);
  await request(f, f.outsider, `projects/${target.id}/experience-reuses`, "POST", reuseInput, 403);
  assert.equal((await request(f, f.owner, `projects/${target.id}/experience-reuses`, "POST", { ...reuseInput, sourceRevision: 1 }, 409)).error?.code, "VERSION_CONFLICT");
  await request(f, f.owner, `projects/${source.id}/stage`, "POST", { expectedRevision: await revision(f, source.id), stage: "archived", reason: "保留私人经验" });
  await request(f, f.owner, `experience-cards/${personal.id}`, "PATCH", { expectedRevision: 2, content }, 409);
  await request(f, f.owner, `experience-cards/${personal.id}/history?revision=1`);
  await request(f, f.owner, `projects/${target.id}/stage`, "POST", { expectedRevision: await revision(f, target.id), stage: "archived", reason: "目标空间只读" });
  await request(f, f.owner, `projects/${target.id}/experience-reuses`, "POST", reuseInput, 409);
  await request(f, f.owner, `projects/${target.id}/management-transfer`, "POST", { expectedRevision: await revision(f, target.id), targetUserId: f.member.actor.userId });
  const freshTarget = (await request<{ project: Project }>(f, f.member, `projects/${target.id}`)).data.project;
  await request(f, f.member, `projects/${target.id}/members/${f.owner.actor.userId}`, "DELETE", { expectedRevision: freshTarget.revision });
  await request(f, f.owner, `experience-reuses/${reuse.id}`, "GET", undefined, 403);
  const preserved = (await request<{ items: ReuseDraftView[] }>(f, f.owner, "experience-reuses")).data.items;
  assert.equal(preserved[0]?.draft.id, reuse.id); assert.equal(preserved[0]?.selectedContent, null);
  assert.deepEqual(preserved[0]?.draft.selectedFields, ["advice", "conditions"]);
  await request(f, f.owner, `experience-reuses/${reuse.id}`, "DELETE", { expectedRevision: 9 }, 409);
  await request(f, f.owner, `experience-reuses/${reuse.id}`, "DELETE", { expectedRevision: 1 });
  await f.database.query("UPDATE auth_sessions SET revoked_at=now() WHERE id=$1", [f.owner.sessionId]);
  for (const path of ["experience-cards", "retrospectives", "experience-reuses", `projects/${target.id}/experience-reuses`, `experience-cards/${personal.id}/history?revision=1`]) await request(f, f.owner, path, "GET", undefined, 401);
});

test("root unfinished retrospective buffers preserve text privately, reject CAS conflicts and remain exportable after archive", async context => {
  const f = await fixture(context); const p = await project(f); await join(f, p);
  const input: EditDraftSaveInput = { documentId: null, baseDocumentRevision: 0, expectedRevision: 0, mutationId: "completion-edit-buffer-first", requestedScope: "project",
    draftContent: { answers: { goalAndOutcome: "", blockerAndResponse: "  尚未保存的半句  ", helpfulPractice: "", scopeReduction: "", nextChange: "" }, evidenceRefs: [], tools: [] } };
  const before = await f.database.query("SELECT * FROM m07_documents");
  const saved = (await request<EditDraftSaveResult>(f, f.owner, `projects/${p.id}/retrospective-edit-draft`, "PUT", input)).data;
  assert.equal(saved.draft.visibility, "personal"); assert.deepEqual(saved.draft.draftContent, input.draftContent);
  assert.deepEqual((await f.database.query("SELECT * FROM m07_documents")).rows, before.rows, "saving a buffer never publishes a formal document");
  assert.equal((await request<EditDraftSaveResult>(f, f.owner, `projects/${p.id}/retrospective-edit-draft`, "PUT", input)).data.replayed, true);
  assert.equal((await request(f, f.owner, `projects/${p.id}/retrospective-edit-draft`, "PUT", { ...input, requestedScope: "personal" }, 409)).error?.code, "IDEMPOTENCY_CONFLICT");
  assert.equal((await request(f, f.owner, `projects/${p.id}/retrospective-edit-draft`, "PUT", { ...input, mutationId: "completion-edit-buffer-stale" }, 409)).error?.code, "VERSION_CONFLICT");
  const path = `retrospective-edit-drafts/${saved.draft.id}`;
  assert.equal((await request<RetrospectiveEditDraft>(f, f.owner, path)).data.id, saved.draft.id);
  assert.equal((await request<EditDraftPage>(f, f.owner, "retrospective-edit-drafts")).data.items.length, 1);
  await request(f, f.member, path, "GET", undefined, 404);
  assert.equal((await request<RetrospectiveEditDraft | null>(f, f.outsider, `projects/${p.id}/retrospective-edit-draft`)).data, null, "a keyed read only returns the current account's own text");
  await request(f, f.outsider, `projects/${p.id}/retrospective-edit-draft`, "PUT", input, 403);
  await request(f, f.owner, `projects/${p.id}/stage`, "POST", { expectedRevision: await revision(f, p.id), stage: "archived", reason: "仍需找回本人未完成草稿" });
  await request(f, f.owner, `projects/${p.id}/retrospective-edit-draft`, "PUT", { ...input, expectedRevision: 1, mutationId: "completion-edit-archived" }, 409);
  const exportRequest = new Request(`${origin}/api/v1/${path}/export`, { method: "POST", headers: { origin, cookie: f.owner.cookie, "content-type": "application/json" }, body: JSON.stringify({ format: "markdown" }) });
  const exported = await dispatch(f.app, exportRequest, [...path.split("/"), "export"]);
  assert.equal(exported.status, 200); assert.match(await exported.text(), /尚未保存的半句/);
  await request(f, f.owner, path, "DELETE", { expectedRevision: 9 }, 409);
  await request(f, f.owner, path, "DELETE", { expectedRevision: 1 });
  await f.database.query("UPDATE auth_sessions SET revoked_at=now() WHERE id=$1", [f.owner.sessionId]);
  for (const read of ["retrospective-edit-drafts", path, `projects/${p.id}/retrospective-edit-draft`]) await request(f, f.owner, read, "GET", undefined, 401);
  await request(f, f.owner, `${path}/export`, "POST", { format: "json" }, 401);
});

async function activePlan(f: Fixture, p: Project) {
  const now = f.app.clock.now().getTime();
  const detail = (await request<{ membership: ProjectMember }>(f, f.owner, `projects/${p.id}`)).data;
  await request(f, f.owner, `projects/${p.id}/my-availability`, "PUT", { expectedRevision: 0, timezone: "UTC", windows: [{ id: "completion-work", startsAt: new Date(now + 3600000).toISOString(), endsAt: new Date(now + 5 * 3600000).toISOString(), effectiveMinutes: 240 }] });
  const eventId = "completion-plan-event"; const content = rules(f, eventId); const deadline = new Date(now + 96 * 3600000).toISOString();
  content.requirements = []; content.stages = [{ id: "submission", stageType: "submission", name: "提交作品", startsAt: null, endsAt: { rawText: deadline, timeZone: "UTC", utc: deadline, dateOnly: false, evidenceIds: ["demo-proof"] }, submissionUrl: "https://example.test/submit" }];
  content.evidence[0] = { ...content.evidence[0]!, fieldKey: "stages.submission.endsAt", excerpt: deadline, rawDateText: deadline };
  await f.app.events.createCandidate(f.admin.actor, content, 0); await f.app.events.requestReview(f.admin.actor, eventId, 1); await f.app.events.publishCandidate(f.admin.actor, eventId, 2);
  await request(f, f.owner, `projects/${p.id}/rules/confirm`, "POST", { eventId, rulesVersion: 1, expectedRevision: 0 });
  const input = await f.app.facts.planningFacts.readInput(p.id, f.app.clock.now().toISOString(), f.owner.actor);
  const tasks: TaskProposal[] = ["implementation" as const, ...input.requiredTaskKinds].map((kind, index) => ({ id: `completion-task-${index}`, projectId: p.id, title: `${kind}任务`, priority: "must", kind,
    ownerMembershipId: detail.membership.membershipId, helperEfforts: [], deliverable: "可复现的成果", acceptanceCriteria: ["核心操作可演示"], reviewerMembershipId: null,
    durationEstimate: { optimisticMinutes: 5, likelyMinutes: 10, pessimisticMinutes: 15, basis: "本人估算" }, dependencyTaskIds: index ? [`completion-task-${index - 1}`] : [], deadlineRef: "submission", requirementRefs: [], resourceRefs: [], splittable: false, contextSwitchMinutes: 0, waitMinutes: 0 }));
  const draft = await f.app.planning.createDraft(f.owner.actor, p.id, { tasks, buffers: [{ deadlineId: "submission", reservedMinutes: 20, basis: "保留提交缓冲" }], reason: "提醒用真实手动计划", expectedTasksRevision: 0, basePlanVersionId: null, idempotencyKey: "completion-plan-first" });
  assert.equal(draft.status, "ready", "a real confirmed plan is required to test active reminders");
  await f.app.planning.apply(f.owner.actor, p.id, draft.id, { expectedRevision: draft.revision, acknowledgedIssueCodes: [...new Set(draft.validation!.issues.map(issue => issue.code))], idempotencyKey: "completion-plan-apply" });
}

test("root planning worker produces deterministic receipts; read is personal and cannot dismiss an active risk", async context => {
  const f = await fixture(context); const p = await project(f); await join(f, p); await activePlan(f, p);
  const current = await f.app.planning.getCurrent(f.owner.actor, p.id); const task = current.tasks.find(item => item.id === "completion-task-0")!;
  await f.app.planning.updateProgress(f.owner.actor, p.id, task.id, { expectedRevision: task.revision, status: "blocked", remainingEstimate: null, blocker: "需要队友协助环境", evidenceRefs: [], note: "真实任务记录", idempotencyKey: "completion-progress-blocked" });
  const report = await f.app.planningNotifications.worker.runOnce({ projectIds: [p.id] });
  assert.deepEqual(report.errors, []); assert.equal(report.modelRequests, 0);
  const own = (await request<OwnPlanningNotification[]>(f, f.owner, "me/planning-notifications")).data.find(item => item.cause === "task_blocked")!;
  const peer = (await request<OwnPlanningNotification[]>(f, f.member, "me/planning-notifications")).data.find(item => item.id === own.id)!;
  assert.ok(own); assert.equal(peer.readAt, null);
  const receipt = (await request<OwnPlanningNotification>(f, f.owner, `me/planning-notifications/${own.id}/read`, "POST", { expectedRevision: own.revision })).data;
  assert.ok(receipt.readAt); assert.equal(receipt.resolvedAt, null);
  assert.equal((await request<OwnPlanningNotification[]>(f, f.member, "me/planning-notifications")).data.find(item => item.id === own.id)?.readAt, null);
  await request(f, f.owner, `me/planning-notifications/${own.id}/read`, "POST", { expectedRevision: own.revision }, 409);
  assert.equal((await request(f, f.owner, `me/planning-notifications/${own.id}/dismiss`, "POST", { expectedRevision: receipt.revision }, 409)).error?.code, "RISK_STILL_ACTIVE");
  await request(f, f.outsider, `me/planning-notifications/${own.id}/read`, "POST", { expectedRevision: 1 }, 404);
  await request(f, f.outsider, `me/planning-notifications/${own.id}/dismiss`, "POST", { expectedRevision: 1 }, 404);
  assert.deepEqual((await request<OwnPlanningNotification[]>(f, f.outsider, "me/planning-notifications")).data, []);
  await request(f, f.owner, `projects/${p.id}/stage`, "POST", { expectedRevision: await revision(f, p.id), stage: "archived", reason: "归档保留提醒记录" });
  await request(f, f.owner, `me/planning-notifications/${own.id}/dismiss`, "POST", { expectedRevision: receipt.revision });
  await request(f, f.owner, `projects/${p.id}/members/${f.member.actor.userId}`, "DELETE", { expectedRevision: await revision(f, p.id) });
  assert.deepEqual((await request<OwnPlanningNotification[]>(f, f.member, "me/planning-notifications")).data, []);
  await request(f, f.member, `me/planning-notifications/${own.id}/read`, "POST", { expectedRevision: peer.revision }, 404);
  await f.database.query("UPDATE auth_sessions SET revoked_at=now() WHERE id=$1", [f.owner.sessionId]);
  await request(f, f.owner, "me/planning-notifications", "GET", undefined, 401);
  for (const action of ["read", "dismiss"]) await request(f, f.owner, `me/planning-notifications/${own.id}/${action}`, "POST", { expectedRevision: receipt.revision }, 401);
});

async function exportOwnData(f: Fixture, who = f.owner) {
  const queued = (await request<DataExportSummary>(f, who, "me/data-exports", "POST", {})).data;
  assert.equal(queued.status, "queued"); assert.equal(queued.revision, 1);
  const ready = (await request<DataExportSummary>(f, who, "me/data-exports/prepare", "POST", { id: queued.id, expectedRevision: queued.revision })).data;
  assert.equal(ready.status, "ready", ready.errorCode ?? "root own-data collection failed"); assert.equal(ready.revision, 2);
  return { queued, ready };
}
async function download(f: Fixture, who: Identity | null, id: string) {
  return dispatch(f.app, new Request(`${origin}/api/v1/me/data-exports/download?id=${encodeURIComponent(id)}`, { headers: who ? { cookie: who.cookie } : {} }), ["me", "data-exports", "download"]);
}

test("root account export collects only own projections, enforces CAS and rechecks team scope at download", async context => {
  const f = await fixture(context); const p = await project(f); await join(f, p);
  const content = { title: "本人导出经验", scenario: "准备演示", advice: ["先整理材料"], conditions: "小队项目", limitations: "重新核对赛事规则", evidenceRefs: [], tools: [] };
  const mine = (await request<ExperienceCard>(f, f.owner, `projects/${p.id}/experience-cards`, "POST", { scope: "personal", content }, 201)).data;
  const other = (await request<ExperienceCard>(f, f.member, `projects/${p.id}/experience-cards`, "POST", { scope: "personal", content: { ...content, title: "PRIVATE_OTHER_OWNER" } }, 201)).data;
  const { queued, ready } = await exportOwnData(f);
  const overview = (await request<AccountDataOverview>(f, f.owner, "me/data-controls")).data;
  assert.equal(overview.exports[0]?.id, ready.id); assert.equal("document" in overview.exports[0]!, false);
  assert.equal((await request(f, f.owner, "me/data-exports/prepare", "POST", { id: queued.id, expectedRevision: queued.revision }, 409)).error?.code, "VERSION_CONFLICT");
  await request(f, f.member, "me/data-exports/prepare", "POST", { id: ready.id, expectedRevision: ready.revision }, 404);
  assert.equal((await download(f, f.member, ready.id)).status, 404);
  assert.equal((await download(f, null, ready.id)).status, 401);
  const attachment = await download(f, f.owner, ready.id); assert.equal(attachment.status, 200);
  assert.equal(attachment.headers.get("cache-control"), "no-store"); assert.match(attachment.headers.get("content-disposition")!, /^attachment;/);
  const document = await attachment.json() as OwnDataDocument;
  assert.equal(document.userId, f.owner.actor.userId); assert.equal(document.profile.id, f.owner.actor.userId);
  for (const rows of Object.values(document.records)) assert.ok(rows.every(row => row.userId === f.owner.actor.userId));
  assert.ok(document.records.retrospectives.some(row => row.id.endsWith(mine.id))); assert.equal(JSON.stringify(document).includes(other.id), false);
  assert.equal(JSON.stringify(document).includes("PRIVATE_OTHER_OWNER"), false); assert.equal(JSON.stringify(document).includes("token_hash"), false);
  const ownerDetail = (await request<{ project: Project }>(f, f.owner, `projects/${p.id}`)).data;
  await request(f, f.owner, `projects/${p.id}/management-transfer`, "POST", { expectedRevision: ownerDetail.project.revision, targetUserId: f.member.actor.userId });
  const memberDetail = (await request<{ project: Project }>(f, f.member, `projects/${p.id}`)).data;
  await request(f, f.member, `projects/${p.id}/members/${f.owner.actor.userId}`, "DELETE", { expectedRevision: memberDetail.project.revision });
  const denied = await download(f, f.owner, ready.id); assert.equal(denied.status, 403);
  assert.equal((await denied.json() as Envelope<unknown>).error?.code, "ACCOUNT_EXPORT_SCOPE_INVALID");
  await f.database.query("UPDATE auth_sessions SET revoked_at=now() WHERE id=$1", [f.owner.sessionId]);
  await request(f, f.owner, "me/data-controls", "GET", undefined, 401);
  await request(f, f.owner, "me/data-exports", "POST", {}, 401); assert.equal((await download(f, f.owner, ready.id)).status, 401);
});

test("root deletion request blocks the last active manager, refreshes after transfer and cancels without claiming deletion", async context => {
  const f = await fixture(context); const p = await project(f); await join(f, p);
  const blocked = (await request<AccountDeletionSummary>(f, f.owner, "me/deletion-requests", "POST", { confirmed: true })).data;
  assert.equal(blocked.status, "blocked"); assert.deepEqual(blocked.impact.lastManagerProjects.map(item => item.projectId), [p.id]);
  assert.equal((await f.database.query<{ status: string }>("SELECT status FROM auth_users WHERE id=$1", [f.owner.actor.userId])).rows[0]?.status, "active");
  assert.equal((await f.database.query("SELECT id FROM auth_sessions WHERE id=$1 AND revoked_at IS NULL", [f.owner.sessionId])).rowCount, 1);
  await request(f, f.member, "me/deletion-requests/refresh", "POST", { id: blocked.id, expectedRevision: blocked.revision }, 404);
  await request(f, f.member, "me/deletion-requests/cancel", "POST", { id: blocked.id, expectedRevision: blocked.revision }, 404);
  await request(f, f.owner, `projects/${p.id}/management-transfer`, "POST", { expectedRevision: await revision(f, p.id), targetUserId: f.member.actor.userId });
  const pending = (await request<AccountDeletionSummary>(f, f.owner, "me/deletion-requests/refresh", "POST", { id: blocked.id, expectedRevision: blocked.revision })).data;
  assert.equal(pending.status, "pending"); assert.equal(pending.revision, blocked.revision + 1); assert.deepEqual(pending.impact.lastManagerProjects, []);
  await request(f, f.owner, "me/deletion-requests/cancel", "POST", { id: blocked.id, expectedRevision: blocked.revision }, 409);
  const cancelled = (await request<AccountDeletionSummary>(f, f.owner, "me/deletion-requests/cancel", "POST", { id: blocked.id, expectedRevision: pending.revision })).data;
  assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.revision, pending.revision + 1);
  assert.equal((await f.database.query<{ status: string }>("SELECT status FROM auth_users WHERE id=$1", [f.owner.actor.userId])).rows[0]?.status, "active");
  await f.database.query("UPDATE auth_sessions SET authenticated_at=$2 WHERE id=$1", [f.owner.sessionId, new Date(f.app.clock.now().getTime() - 6 * 60_000).toISOString()]);
  assert.equal((await request(f, f.owner, "me/deletion-requests", "POST", { confirmed: true }, 403)).error?.code, "AUTH_REAUTHENTICATION_REQUIRED");
  assert.equal((await request(f, f.owner, "me/email-change-challenges", "POST", { newEmail: "recent-required@example.test", expectedRevision: 1 }, 403)).error?.code, "AUTH_REAUTHENTICATION_REQUIRED");
  await f.database.query("UPDATE auth_sessions SET revoked_at=now() WHERE id=$1", [f.owner.sessionId]);
  for (const action of ["refresh", "cancel"]) await request(f, f.owner, `me/deletion-requests/${action}`, "POST", { id: blocked.id, expectedRevision: cancelled.revision }, 401);
});

async function mailboxCode(f: Fixture, recipient: string) {
  const rows = (await f.database.query<{ body: string }>("SELECT body FROM development_mailbox WHERE recipient=$1 ORDER BY created_at,id", [recipient])).rows;
  assert.equal(rows.length, 1); const match = /为：(\d{8})/.exec(rows[0]!.body);
  assert.ok(match, "isolated local mailbox contains a challenge"); return match[1]!;
}
test("root email change requires both mailboxes, preserves identity and intentionally revokes all old sessions", async context => {
  const f = await fixture(context); const newEmail = "completion-new@example.test";
  const receipt = (await request<EmailChangeReceipt>(f, f.owner, "me/email-change-challenges", "POST", { newEmail, expectedRevision: 1 })).data;
  const currentCode = await mailboxCode(f, `${f.owner.actor.userId}@example.test`), newCode = await mailboxCode(f, newEmail);
  await request(f, f.member, "me/email-change-challenges/verify", "POST", { challengeId: receipt.challengeId, currentCode, newCode }, 401);
  for (const codes of [{ currentCode, newCode: "invalid" }, { currentCode: "invalid", newCode }]) await request(f, f.owner, "me/email-change-challenges/verify", "POST", { challengeId: receipt.challengeId, ...codes }, 401);
  const unchanged = (await f.database.query<{ email: string; revision: number }>("SELECT email,revision FROM auth_users WHERE id=$1", [f.owner.actor.userId])).rows[0]!;
  assert.equal(unchanged.email, `${f.owner.actor.userId}@example.test`); assert.equal(unchanged.revision, 1);
  const result = await request<EmailChangeResult>(f, f.owner, "me/email-change-challenges/verify", "POST", { challengeId: receipt.challengeId, currentCode, newCode });
  assert.equal(result.data.profile.id, f.owner.actor.userId); assert.equal(result.data.profile.email, newEmail); assert.equal(result.data.profile.revision, 2);
  assert.equal(result.data.requiresLogin, true); assert.match(result.response.headers.get("set-cookie")!, /Max-Age=0/);
  assert.equal((await f.database.query("SELECT id FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL", [f.owner.actor.userId])).rowCount, 0);
  await request(f, f.owner, "me/data-controls", "GET", undefined, 401);
  await request(f, f.owner, "me/email-change-challenges/verify", "POST", { challengeId: receipt.challengeId, currentCode, newCode }, 401);
});

test("root email verification rejects a changed account revision without consuming its challenge", async context => {
  const f = await fixture(context); const newEmail = "completion-revision@example.test";
  const receipt = (await request<EmailChangeReceipt>(f, f.owner, "me/email-change-challenges", "POST", { newEmail, expectedRevision: 1 })).data;
  const currentCode = await mailboxCode(f, `${f.owner.actor.userId}@example.test`), newCode = await mailboxCode(f, newEmail);
  await f.database.query("UPDATE auth_users SET revision=revision+1 WHERE id=$1", [f.owner.actor.userId]);
  assert.equal((await request(f, f.owner, "me/email-change-challenges/verify", "POST", { challengeId: receipt.challengeId, currentCode, newCode }, 409)).error?.code, "VERSION_CONFLICT");
  const challenge = (await f.database.query<{ consumed_at: unknown }>("SELECT consumed_at FROM auth_email_change_challenges WHERE id=$1", [receipt.challengeId])).rows[0]!;
  assert.equal(challenge.consumed_at, null);
  assert.equal((await f.database.query<{ email: string }>("SELECT email FROM auth_users WHERE id=$1", [f.owner.actor.userId])).rows[0]?.email, `${f.owner.actor.userId}@example.test`);
  assert.equal((await f.database.query("SELECT id FROM auth_sessions WHERE id=$1 AND revoked_at IS NULL", [f.owner.sessionId])).rowCount, 1);
});

test("root retention removes only expired export bodies and temporary development mail; immutable receipts and unknown paid holds remain", async context => {
  const f = await fixture(context); const p = await project(f); const { ready } = await exportOwnData(f);
  const now = f.app.clock.now().toISOString(), old = new Date(f.app.clock.now().getTime() - 48 * 3600000).toISOString(), expired = new Date(f.app.clock.now().getTime() - 24 * 3600000).toISOString();
  await f.database.query("UPDATE auth_data_exports SET created_at=$2::timestamptz,expires_at=$3::timestamptz,body=body || jsonb_build_object('createdAt',$4::text,'expiresAt',$5::text) WHERE id=$1", [ready.id, old, expired, old, expired]);
  await f.database.query("INSERT INTO development_mailbox(id,recipient,subject,body,created_at) VALUES('completion-old-mail','old@example.test','fixture','old',$1),('completion-current-mail','current@example.test','fixture','current',$2)", [old, now]);
  await publishRules(f, "completion-receipt-event");
  await f.database.query("INSERT INTO operations_source_configs(id,revision,status,data,created_at,updated_at) VALUES('completion-source',1,'paused',$1::jsonb,$2,$2)", [JSON.stringify({ id: "completion-source", revision: 1, status: "paused", credentialPolicy: "none" }), old]);
  await f.database.query("INSERT INTO operations_execution_runs(id,kind,source_config_id,revision,status,fingerprint,data,available_at,created_at,updated_at) VALUES('completion-run','crawl','completion-source',1,'review_ready','fixture',$1::jsonb,$2,$2,$2)", [JSON.stringify({ id: "completion-run", kind: "crawl", sourceConfigId: "completion-source", revision: 1, status: "review_ready", attempt: 1, maxAttempts: 1, timeoutMs: 1000 }), old]);
  await f.database.query("INSERT INTO integration_source_results(id,run_id,attempt,kind,source_config_id,source_revision,target_url,input_hash,request_hash,event_id,payload,created_at) VALUES('completion-receipt','completion-run',1,'crawl','completion-source',1,'https://example.test/rules',$1,$1,'completion-receipt-event',$2::jsonb,$3)", ["a".repeat(64), JSON.stringify({ fixtureEvidence: "immutable receipt remains available" }), old]);
  await f.database.query("INSERT INTO operations_discovery_state(id,quota_day,search_calls,model_calls,estimated_cost_micros,last_error_code) VALUES('completion-held-search',$1,1,1,1000,'REQUEST_RESULT_UNKNOWN')", [now.slice(0, 10)]);
  await f.database.query("INSERT INTO operations_discovery_search_attempts(scheduler_id,request_hash,last_attempt_at,cycle_token,last_error_code) VALUES('completion-held-search',$1,$2,'fixture-unknown-cycle','REQUEST_RESULT_UNKNOWN')", ["b".repeat(64), old]);
  await f.database.query("INSERT INTO ai_execution_jobs(id,kind,module_job_id,source_revision,project_id,actor_id,status,attempts,external_state,created_at,updated_at) VALUES('completion-ai-hold','personal_artifact','completion-ai-hold',1,$1,$2,'unknown',1,'unknown',$3,$3)", [p.id, f.owner.actor.userId, old]);
  await f.database.query("INSERT INTO ai_budget_buckets(project_id,period,calls,reserved_micro_usd,charged_micro_usd) VALUES($1,$2,1,1000,0)", [p.id, old.slice(0, 10)]);
  await f.database.query("INSERT INTO ai_usage_attempts(id,execution_id,project_id,actor_id,period,model_version,prompt_version,status,cost_configured,input_rate_micro_usd_per_million,output_rate_micro_usd_per_million,reserved_micro_usd,external_state,created_at) VALUES('completion-ai-attempt','completion-ai-hold',$1,$2,$3,'fixture','fixture','reserved',true,1,1,1000,'unknown',$4)", [p.id, f.owner.actor.userId, old.slice(0, 10), old]);
  const retained = async () => {
    const result: Record<string, unknown> = {};
    for (const table of ["integration_source_results", "operations_execution_runs", "operations_source_configs", "operations_discovery_state", "operations_discovery_search_attempts", "ai_execution_jobs", "ai_budget_buckets", "ai_usage_attempts"]) result[table] = (await f.database.query(`SELECT * FROM ${table} ORDER BY 1`)).rows;
    return result;
  };
  const before = await retained();
  const status = (await request<{ preservedReceiptCount: string; expiredExportDocuments: string }>(f, f.admin, "admin/operations/retention")).data;
  assert.equal(status.preservedReceiptCount, "1"); assert.equal(status.expiredExportDocuments, "1");
  assert.equal((await f.database.query("SELECT id FROM development_mailbox")).rowCount, 2, "admin status only reads maintenance status");
  await request(f, f.member, "admin/operations/retention", "GET", undefined, 403); await request(f, null, "admin/operations/retention", "GET", undefined, 401);
  assert.deepEqual(await f.app.retentionMaintenance.run(), { status: "completed", expiredExportDocuments: 1, expiredDevelopmentMessages: 1 });
  const kept = (await f.database.query<{ body: DataExportSummary & { document: unknown } }>("SELECT body FROM auth_data_exports WHERE id=$1", [ready.id])).rows[0]!.body;
  assert.equal(kept.status, "expired"); assert.equal(kept.document, null); assert.equal(kept.byteLength, null); assert.equal(kept.revision, ready.revision + 1);
  assert.deepEqual((await f.database.query<{ id: string }>("SELECT id FROM development_mailbox ORDER BY id")).rows.map(row => row.id), ["completion-current-mail"]);
  assert.deepEqual(await retained(), before);
  assert.deepEqual(await f.app.retentionMaintenance.run(), { status: "completed", expiredExportDocuments: 0, expiredDevelopmentMessages: 0 });
  const gone = await download(f, f.owner, ready.id); assert.equal(gone.status, 409); assert.equal((await gone.json() as Envelope<unknown>).error?.code, "ACCOUNT_EXPORT_UNAVAILABLE");
});

function exactSkill(candidate: Pick<SkillCandidate, "revision" | "contentHash" | "manifestHash">) {
  return { expectedCandidateRevision: candidate.revision, expectedContentHash: candidate.contentHash, expectedManifestHash: candidate.manifestHash };
}
function candidateFixture(f: Fixture): { document: SkillCandidateDocument; evidence: SkillCandidateEvidence } {
  // Metadata fixture only: no download, installation, client-load or task verification.
  const skill = structuredClone(INITIAL_SKILLS[0]!); const version = skill.versions[0]!; const commit = "e".repeat(40);
  version.commit = commit; version.id = `${skill.id}@${commit}`;
  version.files = version.files.map(file => ({ ...file, downloadUrl: `https://raw.githubusercontent.com/${version.repository}/${commit}/${file.repositoryPath.split("/").map(encodeURIComponent).join("/")}` }));
  version.contentHash = hash(version.files); version.license.sourceUrl = version.files.find(file => file.relativePath === version.license.filePath)!.downloadUrl;
  skill.sourceUrl = `https://github.com/${version.repository}/tree/${commit}/${version.skillPath}`;
  const checkedBy = f.admin.actor.userId, checkedAt = f.app.clock.now().toISOString();
  return { document: { kind: "skill", skill }, evidence: { license: { status: "verified", sourceUrl: version.license.sourceUrl, sha256: version.license.sha256, checkedBy, checkedAt, noticesIncluded: true },
    behavior: { status: "reviewed", checkedBy, checkedAt, note: "隔离测试元数据，不下载或执行第三方内容。" },
    compatibility: version.compatibility.map(entry => ({ agentId: entry.agentId, level: "installer_declared", source: "official_documentation", clientVersion: null, os: null, checkedAt: null, evidenceUrl: entry.evidenceUrl, task: null, limitation: entry.limitation })) } };
}

test("root skill candidate review publishes exact metadata and project references survive withdrawal without installing or upgrading", async context => {
  const f = await fixture(context); const source = await project(f); const target = await project(f); await join(f, source);
  const seed = candidateFixture(f);
  const candidate = (await request<SkillCandidate>(f, f.admin, "admin/skill-candidates", "POST", { expectedRevision: 0, ...seed })).data;
  assert.equal(candidate.state, "draft"); assert.equal(candidate.revision, 1);
  const candidatePath = `admin/skill-candidates/${candidate.kind}/${candidate.id}/${candidate.versionId}`;
  const exact = exactSkill(candidate);
  const pending = (await request<SkillReview>(f, f.admin, `${candidatePath}/reviews`, "POST", exact, 201)).data;
  assert.equal(pending.status, "pending"); assert.equal(pending.revision, 1);
  await request(f, f.owner, `${candidatePath}/reviews`, "POST", exact, 403);
  const reviewPath = `admin/skill-reviews/${pending.reviewId}`;
  assert.equal((await request(f, f.admin, `${reviewPath}/publish`, "POST", { ...exact, expectedRevision: 1 }, 409)).error?.code, "REVIEW_NOT_APPROVED");
  const decision = { ...exact, expectedRevision: 1, decision: "approved", reason: "仅核对夹具许可与行为元数据，客户端任务仍待验证", verification: { licenseChecked: true, behaviorChecked: true, acknowledgedCompatibility: [...AGENT_IDS] } };
  assert.equal((await request(f, f.admin, `${reviewPath}/decide`, "POST", { ...decision, verification: { ...decision.verification, acknowledgedCompatibility: [] } }, 422)).error?.code, "UNKNOWN_NOT_ACKNOWLEDGED");
  const approved = (await request<SkillReview>(f, f.admin, `${reviewPath}/decide`, "POST", decision)).data;
  assert.equal(approved.status, "approved"); assert.equal(approved.revision, 2);
  await request(f, f.admin, `${reviewPath}/publish`, "POST", { ...exact, expectedContentHash: "0".repeat(64), expectedRevision: approved.revision }, 409);
  const published = (await request<SkillReview>(f, f.admin, `${reviewPath}/publish`, "POST", { ...exact, expectedRevision: approved.revision })).data;
  assert.equal(published.status, "published"); assert.equal(published.revision, 3);
  const snapshot = (await request<SkillReviewSnapshot>(f, f.admin, candidatePath)).data;
  assert.equal(snapshot.state, "published"); assert.equal(snapshot.revision, candidate.revision);
  assert.ok(snapshot.evidence.compatibility.every(entry => entry.level === "installer_declared" && entry.clientVersion === null && entry.os === null && entry.task === null));
  const catalog = (await request<{ items: ReviewedSkillOption[] }>(f, f.owner, `projects/${source.id}/skills/catalog`)).data;
  const option = catalog.items.find(item => item.reference.versionId === candidate.versionId)!; assert.ok(option);
  const item: TaskSkillReference = { reference: option.reference, purpose: "核对参赛作品说明", learningMinutes: 20, environment: { agentId: "codex" } };
  assert.equal(item.reference.contentHash, seed.document.kind === "skill" ? seed.document.skill.versions[0]!.contentHash : "wrong fixture kind");
  const saved = (await request<ProjectSkillSelectionState>(f, f.owner, `projects/${source.id}/skills`, "PUT", { expectedRevision: 0, selections: [item] })).data;
  assert.equal(saved.revision, 1); assert.deepEqual(saved.selections, [item]);
  assert.equal((await request<ProjectSkillSelectionView>(f, f.member, `projects/${source.id}/skills`)).data.canManage, false);
  await request(f, f.member, `projects/${source.id}/skills`, "PUT", { expectedRevision: 1, selections: [] }, 403);
  await request(f, f.admin, `projects/${source.id}/skills/catalog`, "GET", undefined, 403);
  await request(f, f.owner, `projects/${source.id}/skills`, "PUT", { expectedRevision: 0, selections: [] }, 409);
  await request(f, f.owner, `projects/${source.id}/skills`, "PUT", { expectedRevision: 1, selections: [{ ...item, reference: { ...item.reference, contentHash: "0".repeat(64) } }] }, 409);
  const copied = (await request<ProjectSkillSelectionState>(f, f.owner, `projects/${target.id}/skills/copy`, "POST", { sourceProjectId: source.id, expectedRevision: 0 })).data;
  assert.deepEqual(copied.selections, [item]); assert.equal(copied.revision, 1);
  const history = (await f.database.query("SELECT * FROM project_skill_selection_history ORDER BY project_id,revision")).rows;
  const withdrawal = { ...exactSkill(snapshot), operationId: "completion-skill-withdraw", reason: "隔离验收撤回固定版本" };
  const removed = (await request(f, f.admin, `${candidatePath}/withdraw`, "POST", withdrawal)).data;
  assert.deepEqual((await request(f, f.admin, `${candidatePath}/withdraw`, "POST", withdrawal)).data, removed);
  await request(f, f.admin, `${candidatePath}/withdraw`, "POST", { ...withdrawal, reason: "同标识不能替换原因" }, 409);
  const after = (await request<ProjectSkillSelectionView>(f, f.owner, `projects/${source.id}/skills`)).data;
  assert.deepEqual(after.selections, [item]); assert.equal(after.availability[0]?.available, false);
  assert.deepEqual((await f.database.query("SELECT * FROM project_skill_selection_history ORDER BY project_id,revision")).rows, history);
  assert.equal((await request(f, f.owner, `projects/${target.id}/skills/copy`, "POST", { sourceProjectId: source.id, expectedRevision: 1 }, 409)).error?.code, "SKILL_REFERENCE_UNAVAILABLE");
  assert.equal((await request<{ items: ReviewedSkillOption[] }>(f, f.owner, `projects/${source.id}/skills/catalog`)).data.items.some(entry => entry.reference.versionId === candidate.versionId), false);
  await request(f, f.owner, `projects/${target.id}/stage`, "POST", { expectedRevision: await revision(f, target.id), stage: "archived", reason: "固定版本历史保留" });
  assert.equal((await request<ProjectSkillSelectionView>(f, f.owner, `projects/${target.id}/skills`)).data.readOnly, true);
  await request(f, f.owner, `projects/${target.id}/skills`, "PUT", { expectedRevision: 1, selections: [] }, 409);
  for (const table of ["skill_installation_plans", "skill_installation_receipts", "ai_execution_jobs"]) assert.equal((await f.database.query(`SELECT * FROM ${table}`)).rowCount, 0);
  await f.database.query("UPDATE auth_sessions SET revoked_at=now() WHERE id=$1", [f.owner.sessionId]);
  await request(f, f.owner, `projects/${source.id}/skills`, "GET", undefined, 401);
  await request(f, null, "admin/skill-reviews", "GET", undefined, 401);
});

test("root source observability keeps historical unknown admission across daily quotas without exposing private metadata or changing ledgers", async context => {
  const f = await fixture(context), now = f.app.clock.now().toISOString(), old = new Date(f.app.clock.now().getTime() - 48 * 3600000).toISOString();
  const sourceId = "completion-observable-source";
  await f.database.query("INSERT INTO operations_source_configs(id,revision,status,data,consecutive_failures,created_at,updated_at) VALUES($1,1,'enabled',$2::jsonb,3,$3,$3)", [sourceId, JSON.stringify({ id: sourceId, revision: 1, status: "enabled", credentialPolicy: "none", sampleUrl: "https://example.test/?token=PRIVATE_URL_SECRET", ownerUserId: "PRIVATE_OWNER" }), now]);
  await f.database.query("INSERT INTO ai_execution_jobs(id,kind,module_job_id,source_revision,project_id,actor_id,status,external_state,created_at,updated_at) VALUES('completion-source-unknown','source','completion-source-unknown',1,$1,'PRIVATE_ACTOR','unknown','unknown',$2,$2)", [`source:${sourceId}`, old]);
  await f.database.query("INSERT INTO ai_usage_attempts(id,execution_id,project_id,actor_id,period,model_version,prompt_version,status,cost_configured,input_rate_micro_usd_per_million,output_rate_micro_usd_per_million,reserved_micro_usd,charged_micro_usd,usage_verified,external_state,created_at,settled_at) VALUES('completion-source-attempt','completion-source-unknown',$1,'PRIVATE_ACTOR',$2,'PRIVATE_MODEL','PRIVATE_PROMPT','settled',true,1,1,100,100,false,'unknown',$3,$3)", [`source:${sourceId}`, old.slice(0, 10), old]);
  await f.database.query("INSERT INTO ai_budget_buckets(project_id,period,calls,reserved_micro_usd,charged_micro_usd) VALUES($1,$2,2,0,100)", [`source:${sourceId}`, now.slice(0, 10)]);
  const snapshot = async () => ({ sources: (await f.database.query("SELECT * FROM operations_source_configs ORDER BY id")).rows, jobs: (await f.database.query("SELECT * FROM ai_execution_jobs ORDER BY id")).rows, attempts: (await f.database.query("SELECT * FROM ai_usage_attempts ORDER BY id")).rows, budget: (await f.database.query("SELECT * FROM ai_budget_buckets ORDER BY project_id,period")).rows });
  const before = await snapshot(), path = `admin/sources/${sourceId}/observability`;
  const result = await request<SourceObservabilityReport>(f, f.admin, path);
  assert.equal(result.data.runtime?.model?.unknownRequests, 1); assert.equal(result.data.runtime?.model?.admission, "unknown_request");
  assert.equal(result.data.runtime?.model?.completeCostMicroUsd, null); assert.equal(result.data.runtime?.model?.calls, 2);
  assert.equal(result.data.source.consecutiveCrawlFailures, 3); assert.deepEqual(result.data.runtime?.worker, { scope: "all_sources", status: "not_started", lastSeenAt: null });
  assert.doesNotMatch(JSON.stringify(result.data), /PRIVATE_|example\.test|token_hash|lease_token/);
  assert.ok(result.response.headers.get("cache-control")?.includes("no-store"));
  await request(f, f.admin, `${path}?limit=1&limit=2`, "GET", undefined, 422);
  await request(f, f.member, path, "GET", undefined, 403); await request(f, null, path, "GET", undefined, 401);
  assert.deepEqual(await snapshot(), before);
  await f.database.query("UPDATE auth_users SET platform_roles=ARRAY['user']::text[] WHERE id=$1", [f.admin.actor.userId]);
  await request(f, f.admin, path, "GET", undefined, 403);
  await f.database.query("UPDATE auth_users SET platform_roles=ARRAY['admin']::text[] WHERE id=$1", [f.admin.actor.userId]);
  await f.database.query("UPDATE auth_sessions SET revoked_at=now() WHERE id=$1", [f.admin.sessionId]);
  await request(f, f.admin, path, "GET", undefined, 401); assert.deepEqual(await snapshot(), before);
});

test("root resource maintenance exact GET remains read-only and protected from generic resource routes", async context => {
  const f = await fixture(context), now = f.app.clock.now().toISOString(), future = new Date(f.app.clock.now().getTime() + 600000).toISOString();
  assert.equal((await f.database.query("SELECT id FROM resource_records")).rowCount, 0, "empty approved resource fixture prevents DNS, robots and HEAD calls");
  const path = "admin/resources/link-checks";
  const initial = (await request<ResourceLinkMaintenanceStatus>(f, f.admin, path)).data;
  assert.equal(initial.state, null); assert.deepEqual(initial.results, []);
  assert.equal((await f.database.query("SELECT id FROM resource_link_maintenance_state")).rowCount, 0, "GET does not initialize a worker lease");
  await request(f, f.member, path, "GET", undefined, 403); await request(f, null, path, "GET", undefined, 401);
  assert.equal((await request(f, f.admin, `${path}?limit=1&limit=2`, "GET", undefined, 422)).error?.code, "INVALID_RESOURCE_CHECK_QUERY");
  await request(f, f.admin, path, "PATCH", {}, 405);
  await f.database.query("INSERT INTO resource_link_maintenance_state(id,cycle,lease_token,lease_until,next_eligible_at,last_started_at) VALUES('approved_resources',1,'PRIVATE_OLD_LEASE',$2,$1,$1)", [now, future]);
  const before = (await f.database.query("SELECT * FROM resource_link_maintenance_state")).rows;
  const safe = (await request<ResourceLinkMaintenanceStatus>(f, f.admin, path)).data;
  assert.equal(safe.state?.phase, "running"); assert.doesNotMatch(JSON.stringify(safe), /PRIVATE_|lease_token|leaseToken/);
  assert.deepEqual((await f.database.query("SELECT * FROM resource_link_maintenance_state")).rows, before);
  await f.database.query("UPDATE auth_users SET platform_roles=ARRAY['user']::text[] WHERE id=$1", [f.admin.actor.userId]);
  await request(f, f.admin, path, "GET", undefined, 403);
  await f.database.query("UPDATE auth_users SET platform_roles=ARRAY['admin']::text[] WHERE id=$1", [f.admin.actor.userId]);
  await f.database.query("UPDATE auth_sessions SET revoked_at=now() WHERE id=$1", [f.admin.sessionId]);
  await request(f, f.admin, path, "GET", undefined, 401);
});

test("root resource maintenance preserves a new owner's lease after an old worker finishes without any eligible URLs", async context => {
  const f = await fixture(context), now = f.app.clock.now().toISOString(), future = new Date(f.app.clock.now().getTime() + 600000).toISOString();
  assert.equal((await f.database.query("SELECT id FROM resource_records")).rowCount, 0, "empty approved resource fixture prevents DNS, robots and HEAD calls");
  await f.database.query("INSERT INTO resource_link_maintenance_state(id,cycle,lease_token,lease_until,next_eligible_at,last_started_at) VALUES('approved_resources',1,'PRIVATE_OLD_LEASE',$2,$1,$1)", [now, future]);
  const snapshot = async () => (await f.database.query("SELECT * FROM resource_link_maintenance_state WHERE id='approved_resources'")).rows;
  const busy = await snapshot(); assert.equal((await f.app.resourceLinkMaintenance.runOnce()).status, "busy"); assert.deepEqual(await snapshot(), busy);
  await f.database.query("UPDATE resource_link_maintenance_state SET lease_token=NULL,lease_until=NULL,next_eligible_at=$1 WHERE id='approved_resources'", [future]);
  const waiting = await snapshot(); assert.equal((await f.app.resourceLinkMaintenance.runOnce()).status, "waiting"); assert.deepEqual(await snapshot(), waiting);
  await f.database.query("UPDATE resource_link_maintenance_state SET next_eligible_at=$1 WHERE id='approved_resources'", [now]);
  const originalQuery = f.database.query.bind(f.database); let replaced = false;
  f.database.query = async <Row>(statement: string, parameters?: readonly unknown[]) => {
    const result = await originalQuery<Row>(statement, parameters);
    if (!replaced && statement.includes("ORDER BY (SELECT max(c.checked_at)")) {
      assert.equal(result.rows.length, 0); replaced = true;
      await originalQuery("UPDATE resource_link_maintenance_state SET lease_token='PRIVATE_NEW_LEASE',lease_until=$1,cycle=cycle+1 WHERE id='approved_resources'", [future]);
    }
    return result;
  };
  const run = await f.app.resourceLinkMaintenance.runOnce(); f.database.query = originalQuery;
  assert.equal(replaced, true); assert.equal(run.checked, 0); assert.equal(run.skippedChanged, 0);
  const newLease = (await f.database.query<{ lease_token: string; cycle: number | string; last_completed_at: unknown }>("SELECT lease_token,cycle,last_completed_at FROM resource_link_maintenance_state WHERE id='approved_resources'")).rows[0]!;
  assert.equal(newLease.lease_token, "PRIVATE_NEW_LEASE"); assert.equal(Number(newLease.cycle), 3); assert.equal(newLease.last_completed_at, null, "a stale worker cannot clear a new owner's lease or set its completion time");
  assert.equal((await f.database.query("SELECT * FROM resource_link_check_results")).rowCount, 0);
});
