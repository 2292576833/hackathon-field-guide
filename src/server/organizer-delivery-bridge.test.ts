import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import type { HostedEventScope, EventRosterTeamSnapshot, OrganizerPrincipal, VerifiedEventSubmissionPort } from "../shared/organizer-contracts.ts";
import type { Project, ProjectMember } from "../modules/projects/index.ts";
import type { EventRecord, EventRuleVersion, ProjectRuleConfirmation } from "../modules/events/index.ts";
import { ProjectsService, PostgresProjectsRepository, createInvitationTokens } from "../modules/projects/index.ts";
import { PostgresEventsRepository } from "../modules/events/index.ts";
import { DeliveryService, PostgresDeliveryStore } from "../modules/github/index.ts";
import type { SubmissionRecord } from "../modules/github/index.ts";
import { DomainError } from "../shared/errors.ts";
import { createDatabase } from "./database.ts";
import { createOrganizerDeliveryBridge } from "./organizer-delivery-bridge.ts";

const origin = "https://hib.example.test:44353", instant = "2026-10-11T08:00:00.000Z";
const actor = { userId: "captain", platformRoles: ["user"] as const }, clock = { now: () => new Date(instant) };
const ids = { next: () => randomUUID() };
const flags = { registration: true, teams: true, icebreaking: false, judging: true, schedule: false, accommodation: false, mealVouchers: false };
function hosted(): HostedEventScope {
  return { organizationId: "org", organizationName: "测试主办方", eventId: "hosted", title: "正式黑客松", status: "published", revision: 4, publishedRevision: 4,
    timezone: "Asia/Shanghai", startsAt: instant, endsAt: "2026-10-12T08:00:00.000Z", registrationOpensAt: null, registrationClosesAt: null, submissionClosesAt: "2026-10-12T08:00:00.000Z", modules: flags,
    registration: { reviewRequired: false, capacity: null }, teams: { mode: "free", minSize: 1, maxSize: 4, locksAt: null }, linkedEventId: "m03" };
}
function roster(): EventRosterTeamSnapshot { return { id: "team", eventId: "hosted", organizationId: "org", captainUserId: "captain", memberUserIds: ["captain"], revision: 3, status: "locked", projectId: "project", eligible: true }; }
function project(): Project { return { id: "project", name: "空间", teamId: null, eventId: null, createdBy: "captain", goal: "参赛", minimumDeliverable: "demo", stage: "active", timezone: "Asia/Shanghai", deadline: null, deadlineSource: "unknown", revision: 1, createdAt: instant, updatedAt: instant }; }
function members(projectId = "project"): ProjectMember[] { return [{ membershipId: "member", projectId, userId: "captain", role: "manager", status: "active", revision: 1, joinedAt: instant, leftAt: null }]; }
function confirmation(projectId = "project"): ProjectRuleConfirmation { return { projectId, eventId: "m03", rulesVersion: 2, revision: 7, analysisId: null, confirmedBy: "captain", confirmedAt: instant }; }
function published(): EventRecord { return { id: "m03", revision: 5, publicationStatus: "published", candidateVersion: 2, publishedVersion: 2, lastVerifiedAt: instant }; }
function rules(): EventRuleVersion {
  return { eventId: "m03", version: 2, createdAt: instant, metadata: { name: "正式黑客松", organizer: "测试主办方", format: "online", region: "线上", officialUrl: `${origin}/competitions/hosted` },
    sources: [], evidence: [], facts: [], stages: [{ id: "stage", stageType: "submission", name: "正式提交", startsAt: null, endsAt: null, submissionUrl: `${origin}/competitions/hosted/submit` }], requirements: [], qualityFlags: [] };
}
type Receipt = Parameters<VerifiedEventSubmissionPort["recordReceipt"]>[2];
function receipt(): Receipt { return { id: "receipt", eventId: "hosted", linkedEventId: "m03", teamId: "team", projectId: "project", stageId: "stage", requirementsVersion: "m03:2:7", submittedAt: instant,
  materialHash: "a".repeat(64), receiptUrl: "/competitions/hosted/submit?receipt=receipt", repositoryCommitSha: null }; }
function code(expected: string) { return (error: unknown) => error instanceof DomainError && error.code === expected; }

function fixture() {
  const state = { event: hosted(), team: roster(), project: project(), members: members(), confirmation: confirmation() as ProjectRuleConfirmation | null, published: published(), rules: rules(), guardCalls: 0, revoked: false };
  let committed = new Map<string, SubmissionRecord>(), working: Map<string, SubmissionRecord> | null = null;
  const calls: { sql: SqlExecutor; statement: string }[] = [], deliveries: DatabasePort[] = [];
  const sql: SqlExecutor = { async query(statement) { calls.push({ sql: this, statement }); return { rows: [], rowCount: 0 }; } };
  const database: DatabasePort = { query: sql.query.bind(sql), async transaction(work) {
    working = new Map(committed); try { const output = await work(sql); committed = working; return output; } finally { working = null; }
  } };
  const principal: OrganizerPrincipal = { actor, async guard(received) { assert.equal(received, sql); state.guardCalls++; if (state.revoked) throw new DomainError("UNAUTHENTICATED", "账号已失效", { status: 401 }); } };
  const bridge = createOrganizerDeliveryBridge({ clock, origin,
    hostedEvents: { async getEvent(received, eventId) { assert.equal(received, sql); return eventId === state.event.eventId ? structuredClone(state.event) : null; } },
    participation: { async getTeam(received, eventId, teamId) { assert.equal(received, sql); return eventId === state.team.eventId && teamId === state.team.id ? structuredClone(state.team) : null; } },
    projectsRepository: { async getPlanningContextForUpdate(received, projectId, userId) { assert.equal(received, sql); assert.equal(projectId, state.project.id); assert.equal(userId, actor.userId); return structuredClone({ project: state.project, members: state.members, availability: [] }); } },
    createEventsRepository: bound => ({ async getConfirmation() { await bound.query("fixture_confirmation"); return structuredClone(state.confirmation); }, async getEvent() { await bound.query("fixture_published"); return structuredClone(state.published); }, async getRules() { await bound.query("fixture_rules"); return structuredClone(state.rules); } }),
    createDeliveryStore: bound => { deliveries.push(bound); return { async getSubmission(projectId, id) { await bound.query("fixture_submission_read"); const old = working!.get(id); return old?.projectId === projectId ? structuredClone(old) : null; }, async insertSubmission(record) { await bound.transaction(async tx => { assert.equal(tx, sql); await tx.query("fixture_submission_append"); working!.set(record.id, structuredClone(record)); }); } }; },
  });
  return { state, sql, calls, deliveries, principal, bridge, database, committed: () => [...committed.values()], revokeAfterAppend() {
    const original = sql.query;
    sql.query = async function(statement, parameters) { const result = await original.call(sql, statement, parameters); if (statement === "fixture_submission_append") state.revoked = true; return result as never; };
  } };
}

test("可信桥使用完整确认版本；正式入口与材料回执分开，同一 executor 追加并幂等", async () => {
  const f = fixture();
  await f.database.transaction(async sql => {
    assert.deepEqual(await f.bridge.submissionLinkContext.resolve(sql, f.principal, f.state.event, f.state.team), { stageId: "stage", requirementsVersion: "m03:2:7", repositoryCommitSha: null });
    assert.deepEqual(await f.bridge.verifiedSubmissions.recordReceipt(sql, f.principal, receipt()), { submissionRecordId: "hosted-intake:receipt" });
    await f.bridge.verifiedSubmissions.recordReceipt(sql, f.principal, receipt());
  });
  assert.equal(f.committed().length, 1);
  const stored = f.committed()[0]!;
  assert.equal(stored.verificationSource, "platform_verified"); assert.equal(stored.status, "verified"); assert.equal(stored.eventId, "m03");
  assert.equal(stored.platformUrl, `${origin}/competitions/hosted/submit`);
  assert.deepEqual(stored.evidenceRefs, [`${origin}/competitions/hosted/submit?receipt=receipt`, `hosted-material-sha256:${"a".repeat(64)}`]);
  assert.equal(stored.repositoryCommitSha, null); assert.equal(f.calls.filter(row => row.statement === "fixture_submission_append").length, 1);
  assert.ok(f.calls.every(row => row.sql === f.sql)); assert.ok(f.state.guardCalls >= 6);
});

test("未明确关联 M03 或 M02 时返回 null，不制造平台记录", async () => {
  for (const missing of ["event", "team"] as const) {
    const f = fixture(); if (missing === "event") f.state.event = { ...f.state.event, linkedEventId: null }; else f.state.team = { ...f.state.team, projectId: null };
    assert.equal(await f.database.transaction(sql => f.bridge.submissionLinkContext.resolve(sql, f.principal, f.state.event, f.state.team)), null);
    assert.equal(f.calls.length, 0); assert.equal(f.committed().length, 0);
    await assert.rejects(f.database.transaction(sql => f.bridge.verifiedSubmissions.recordReceipt(sql, f.principal, receipt())), code("HOSTED_RECEIPT_UNLINKED"));
  }
});

test("错赛事、陈旧确认、错误阶段和已更改关联均不能变成平台核验", async () => {
  const variants = [
    { mutate(f: ReturnType<typeof fixture>) { f.state.confirmation = { ...confirmation(), eventId: "other" }; }, code: "REQUIREMENTS_NOT_CONFIRMED" },
    { mutate(f: ReturnType<typeof fixture>) { f.state.published = { ...published(), publishedVersion: 3 }; }, code: "REQUIREMENTS_VERSION_CONFLICT" },
    { mutate(f: ReturnType<typeof fixture>) { f.state.rules = { ...rules(), stages: [{ ...rules().stages[0]!, submissionUrl: `${origin}/competitions/other/submit` }] }; }, code: "SUBMISSION_STAGE_UNCONFIRMED" },
    { mutate(f: ReturnType<typeof fixture>) { f.state.rules = { ...rules(), stages: [...rules().stages, { ...rules().stages[0]!, id: "ambiguous" }] }; }, code: "SUBMISSION_STAGE_UNCONFIRMED" },
    { mutate(f: ReturnType<typeof fixture>) { f.state.project = { ...project(), stage: "archived" }; }, code: "PROJECT_ARCHIVED" },
    { mutate(f: ReturnType<typeof fixture>) { f.state.members = [{ ...members()[0]!, status: "removed" }]; }, code: "PROJECT_ACCESS_DENIED" },
  ];
  for (const variant of variants) {
    const f = fixture(); variant.mutate(f); await assert.rejects(f.database.transaction(sql => f.bridge.submissionLinkContext.resolve(sql, f.principal, f.state.event, f.state.team)), code(variant.code)); assert.equal(f.committed().length, 0);
  }
  const f = fixture(), previous = structuredClone(f.state.team); f.state.team = { ...f.state.team, revision: 4 };
  await assert.rejects(f.database.transaction(sql => f.bridge.submissionLinkContext.resolve(sql, f.principal, f.state.event, previous)), code("HOSTED_LINK_CONTEXT_CHANGED"));
});

test("recordReceipt 重新读取根事实，不能注入规则确认、SHA、其他比赛或空间", async () => {
  for (const patch of [{ requirementsVersion: "2" }, { requirementsVersion: "m03:2:6" }, { linkedEventId: "other" }, { projectId: "other" }, { stageId: "other" }, { repositoryCommitSha: "b".repeat(40) }]) {
    const f = fixture(); await assert.rejects(f.database.transaction(sql => f.bridge.verifiedSubmissions.recordReceipt(sql, f.principal, { ...receipt(), ...patch })), code("HOSTED_RECEIPT_FACT_MISMATCH")); assert.equal(f.committed().length, 0);
  }
  const changed = fixture();
  await assert.rejects(changed.database.transaction(async sql => {
    const link = await changed.bridge.submissionLinkContext.resolve(sql, changed.principal, changed.state.event, changed.state.team);
    assert.equal(link?.requirementsVersion, "m03:2:7");
    changed.state.confirmation = { ...confirmation(), revision: 8 };
    await changed.bridge.verifiedSubmissions.recordReceipt(sql, changed.principal, receipt());
  }), code("HOSTED_RECEIPT_FACT_MISMATCH"));
  assert.equal(changed.committed().length, 0);
});

test("回执只允许同赛事正式入口的唯一 receipt 参数，不接受外域、路径换赛或多余参数", async () => {
  const addresses = ["https://outside.example.test/competitions/hosted/submit?receipt=receipt", "/competitions/other/submit?receipt=receipt", "/competitions/hosted/submit?receipt=other", "/competitions/hosted/submit?receipt=receipt&x=1", "/competitions/hosted/submit?receipt=receipt&receipt=receipt", "/competitions/hosted/submissions/receipt", "/competitions/hosted/submit?receipt=receipt#fragment"];
  for (const receiptUrl of addresses) {
    const f = fixture(); await assert.rejects(f.database.transaction(sql => f.bridge.verifiedSubmissions.recordReceipt(sql, f.principal, { ...receipt(), receiptUrl })), code("HOSTED_RECEIPT_URL_MISMATCH")); assert.equal(f.committed().length, 0);
  }
});

test("同回执 ID 不同材料不能重放；会话撤权使整笔事务回滚", async () => {
  const f = fixture(); await f.database.transaction(sql => f.bridge.verifiedSubmissions.recordReceipt(sql, f.principal, receipt()));
  await assert.rejects(f.database.transaction(sql => f.bridge.verifiedSubmissions.recordReceipt(sql, f.principal, { ...receipt(), materialHash: "b".repeat(64) })), code("HOSTED_RECEIPT_REPLAY_CONFLICT"));
  assert.equal(f.committed().length, 1); assert.equal(f.committed()[0]!.evidenceRefs[1], `hosted-material-sha256:${"a".repeat(64)}`);
  const revoked = fixture(); revoked.revokeAfterAppend();
  await assert.rejects(revoked.database.transaction(sql => revoked.bridge.verifiedSubmissions.recordReceipt(sql, revoked.principal, receipt())), code("UNAUTHENTICATED")); assert.equal(revoked.committed().length, 0);
});

test("真实 PGlite 公共适配器同事务保存 M06 平台核验，公开 DeliveryService 仍拒绝伪造", async () => {
  const database = await createDatabase({});
  try {
    await database.migrate();
    await database.query("INSERT INTO auth_users(id,email,display_name,timezone,status,platform_roles,email_verified_at,created_at,revision) VALUES($1,$2,$1,'Asia/Shanghai','active',ARRAY['user'],$3,$3,1)", [actor.userId, "captain@example.test", instant]);
    const projectsRepository = new PostgresProjectsRepository(database), events = new PostgresEventsRepository(database), store = new PostgresDeliveryStore(database);
    const projects = new ProjectsService({ repository: projectsRepository, clock, ids, tokens: createInvitationTokens() });
    const created = await projects.createProject(actor, { name: "隔离正式收件", timezone: "Asia/Shanghai" });
    await events.transaction(async tx => { await tx.saveEvent({ ...published(), revision: 1 }, 0); await tx.insertRules(rules()); await tx.saveConfirmation({ ...confirmation(created.id), revision: 1 }, 0); });
    const event = hosted(), team = { ...roster(), projectId: created.id };
    const principal: OrganizerPrincipal = { actor, async guard(sql) { const result = await sql.query("SELECT id FROM auth_users WHERE id=$1 AND status='active' FOR SHARE", [actor.userId]); if (!result.rowCount) throw new DomainError("UNAUTHENTICATED", "失效", { status: 401 }); } };
    const bridge = createOrganizerDeliveryBridge({ projectsRepository, clock, origin, hostedEvents: { async getEvent() { return event; } }, participation: { async getTeam() { return team; } } });
    const actualReceipt = { ...receipt(), projectId: created.id, requirementsVersion: "m03:2:1" };
    const result = await database.transaction(async sql => {
      const link = await bridge.submissionLinkContext.resolve(sql, principal, event, team); assert.equal(link?.requirementsVersion, actualReceipt.requirementsVersion);
      return bridge.verifiedSubmissions.recordReceipt(sql, principal, actualReceipt);
    });
    const saved = await store.getSubmission(created.id, result.submissionRecordId);
    assert.equal(saved?.verificationSource, "platform_verified"); assert.equal(saved?.status, "verified"); assert.equal(saved?.platformUrl, rules().stages[0]!.submissionUrl);
    assert.equal((await database.query("SELECT id FROM m06_delivery_fact_events WHERE aggregate_id=$1", [result.submissionRecordId])).rowCount, 1);
    const delivery = new DeliveryService({ access: projectsRepository, capabilities: { async getCapabilities() { return { saveRepository: false, verifyDelivery: true, recordSubmission: true }; } }, store, requirements: { async assertConfirmed() {} }, clock, ids });
    await assert.rejects(delivery.recordSubmission(actor, created.id, { eventId: "m03", stageId: "stage", requirementsVersion: "m03:2:1", platformUrl: `${origin}/competitions/hosted/submit`, submittedAt: instant, status: "reported", evidenceRefs: ["proof"], verificationSource: "platform_verified" } as never), code("INVALID_DELIVERY_INPUT"));
    await assert.rejects(delivery.recordSubmission(actor, created.id, { eventId: "m03", stageId: "stage", requirementsVersion: "m03:2:1", platformUrl: `${origin}/competitions/hosted/submit`, submittedAt: instant, status: "verified", evidenceRefs: ["proof"] } as never), code("INVALID_DELIVERY_INPUT"));
    await assert.rejects(database.transaction(async sql => { await bridge.verifiedSubmissions.recordReceipt(sql, principal, { ...actualReceipt, id: "rollback", receiptUrl: "/competitions/hosted/submit?receipt=rollback" }); throw new Error("outer intake failed"); }), /outer intake failed/);
    assert.equal(await store.getSubmission(created.id, "hosted-intake:rollback"), null);
    assert.equal((await database.query("SELECT id FROM m06_delivery_fact_events WHERE aggregate_id=$1", ["hosted-intake:rollback"])).rowCount, 0);
  } finally { await database.close(); }
});
