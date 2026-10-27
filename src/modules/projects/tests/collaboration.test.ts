import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "../../../shared/contracts.ts";
import { DomainError } from "../../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../../shared/persistence.ts";
import { PostgresOfficialTrackRulesPort } from "../../events/index.ts";
import type { EventRuleVersion } from "../../events/index.ts";
import { PostgresProjectsRepository } from "../postgres.ts";
import { ProjectsService } from "../service.ts";
import { createInvitationTokens } from "../tokens.ts";
import { ProjectCollaborationService } from "../collaboration.ts";
import type { MemberIntentionInput, TrackSelectionInput } from "../collaboration.ts";
import { PostgresProjectCollaborationRepository } from "../collaboration-postgres.ts";
import { createProjectCollaborationHandlers } from "../collaboration-handlers.ts";

const alice: Actor = { userId: "alice", platformRoles: ["user"] };
const bob: Actor = { userId: "bob", platformRoles: ["user"] };
const outsider: Actor = { userId: "outsider", platformRoles: ["admin"] };
const time = "2026-10-09T00:00:00.000Z";
const privateInput: MemberIntentionInput = { expectedRevision: 0, duties: ["design", "development"], experience: "只给本人看的经验", wantsAiHelp: true, helpQuestion: "私密问题", share: { duties: true, experience: false, wantsAiHelp: false, helpQuestion: false } };

function rules(version = 1): EventRuleVersion {
  return {
    eventId: "event", version, createdAt: time,
    metadata: { name: "测试比赛", organizer: "官方", format: "online", region: "", officialUrl: "https://example.com" },
    sources: [{ id: "source", eventId: "event", version, sourceConfigId: null, url: "https://example.com", kind: "official", contentHash: "hash", fetchedAt: time, trustScope: "official_rules", status: "available" }],
    evidence: [{ id: "proof", eventId: "event", version, sourceId: "source", fieldKey: "official_tracks", excerpt: "原型赛道", locator: "#tracks", rawDateText: null, verifiedBy: "reviewer", verifiedAt: time, conflictsWith: [] }],
    facts: ["eligibility", "fees", "team_size", "ai_policy"].map(key => ({ key, statement: "待确认", status: "unknown", evidenceIds: [] })), stages: [], requirements: [], qualityFlags: ["missing_information"],
    officialTracks: { status: "confirmed", evidenceIds: ["proof"], tracks: [{ id: "prototype", name: "原型赛道", evidenceIds: ["proof"], eligibility: null, scoringFocus: null, deliverables: [] }] },
  };
}
function queryAdapter(client: Pick<PGlite, "query">): SqlExecutor {
  return { async query<Row>(sql: string, params: readonly unknown[] = []) { const result = await client.query<Row>(sql, [...params]); return { rows: result.rows, rowCount: result.rowCount ?? result.affectedRows ?? result.rows.length }; } };
}
async function setup() {
  // Isolated memory-only PostgreSQL engine. Never opens the running website's data directory.
  const pg = new PGlite(); const executor = queryAdapter(pg);
  const database: DatabasePort = { ...executor, transaction: work => pg.transaction(transaction => work(queryAdapter(transaction))) };
  await pg.exec(await readFile(new URL("../sql/001-projects.sql", import.meta.url), "utf8"));
  await pg.exec(await readFile(new URL("../../events/migrations/001-events.sql", import.meta.url), "utf8"));
  await pg.exec(await readFile(new URL("../sql/ux-official-tracks-intentions.sql", import.meta.url), "utf8"));
  await pg.exec(await readFile(new URL("../sql/ux-invitation-capacity.sql", import.meta.url), "utf8"));
  await pg.exec(await readFile(new URL("../sql/invitation-acceptance-membership.sql", import.meta.url), "utf8"));
  const repository = new PostgresProjectsRepository(database); let sequence = 0;
  const dependencies = { clock: { now: () => new Date(time) }, ids: { next: () => `id-${++sequence}` } };
  const projects = new ProjectsService({ repository, ...dependencies, tokens: createInvitationTokens() });
  const project = await projects.createProject(alice, { name: "同一个团队空间", timezone: "Asia/Shanghai" });
  const invite = await projects.createProjectInvitation(alice, project.id, { expectedRevision: project.revision, role: "member" });
  await projects.acceptInvitation(bob, invite.token);
  const collaboration = new ProjectCollaborationService({ projects: repository, repository: new PostgresProjectCollaborationRepository(), officialRules: new PostgresOfficialTrackRulesPort(), ...dependencies });
  const snapshot = rules();
  await executor.query("INSERT INTO m03_events (id, revision, body) VALUES ($1, $2, $3::jsonb)", ["event", 1, JSON.stringify({ id: "event", revision: 1, publicationStatus: "published", candidateVersion: 1, publishedVersion: 1, lastVerifiedAt: time })]);
  await executor.query("INSERT INTO m03_rule_versions (event_id, version, body) VALUES ($1, $2, $3::jsonb)", ["event", 1, JSON.stringify(snapshot)]);
  await executor.query("INSERT INTO m03_project_rules (id, revision, body) VALUES ($1, $2, $3::jsonb)", [project.id, 1, JSON.stringify({ projectId: project.id, eventId: "event", rulesVersion: 1, revision: 1, analysisId: null, confirmedBy: "alice", confirmedAt: time })]);
  return { pg, executor, projects, collaboration, projectId: project.id };
}
async function reject(promise: Promise<unknown>, code: string) { await assert.rejects(promise, error => error instanceof DomainError && error.code === code); }
const selection: TrackSelectionInput = { expectedRevision: 0, eventId: "event", rulesVersion: 1, confirmationRevision: 1, trackId: "prototype", reason: "本队选原型" };

test("intentions persist with explicit sharing, private history and public revision-only audit", async () => {
  const f = await setup();
  try {
    const saved = await f.collaboration.updateMyIntention(bob, f.projectId, privateInput);
    assert.equal(saved.intention?.revision, 1); assert.equal(saved.projectRevision, 4);
    assert.deepEqual((await f.collaboration.getMyIntention(bob, f.projectId)).intention?.duties, ["design", "development"]);
    const shared = (await f.collaboration.getSharedIntentions(alice, f.projectId)).intentions[0]!;
    assert.deepEqual(shared.duties, ["design", "development"]);
    assert.equal("experience" in shared, false); assert.equal("helpQuestion" in shared, false); assert.equal("wantsAiHelp" in shared, false);
    const activities = await f.projects.getActivity(alice, f.projectId);
    assert.equal(JSON.stringify(activities).includes("私密"), false); assert.equal(JSON.stringify(activities).includes("只给本人"), false);
    const withdrawn = await f.collaboration.updateMyIntention(bob, f.projectId, { ...privateInput, expectedRevision: 1, share: { duties: false, experience: false, wantsAiHelp: false, helpQuestion: false } });
    assert.equal(withdrawn.intention?.revision, 2);
    const latest = (await f.collaboration.getSharedIntentions(alice, f.projectId)).intentions[0]!;
    assert.equal(latest.revision, 2); assert.equal("duties" in latest, false);
    const history = await f.executor.query<{ count: string }>("SELECT count(*) FROM projects_member_intention_history"); assert.equal(Number(history.rows[0]?.count), 2);
  } finally { await f.pg.close(); }
});
test("self-only intention writes, archived/left reads, invalid arrays and missing consent are enforced", async () => {
  const f = await setup();
  try {
    await reject(f.collaboration.getMyIntention(outsider, f.projectId), "PROJECT_UNAVAILABLE");
    await reject(f.collaboration.updateMyIntention(bob, f.projectId, { ...privateInput, userId: "alice" } as MemberIntentionInput), "INVALID_INPUT");
    await reject(f.collaboration.updateMyIntention(bob, f.projectId, { ...privateInput, duties: ["design", "design"] }), "INVALID_INPUT");
    await reject(f.collaboration.updateMyIntention(bob, f.projectId, { ...privateInput, share: { duties: true } } as MemberIntentionInput), "INVALID_INPUT");
    await f.collaboration.updateMyIntention(bob, f.projectId, privateInput);
    const revision = (await f.projects.getProject(alice, f.projectId)).project.revision;
    await f.projects.transitionStage(alice, f.projectId, { expectedRevision: revision, stage: "archived", reason: "测试归档" });
    assert.equal((await f.collaboration.getMyIntention(bob, f.projectId)).readonly, true);
    await reject(f.collaboration.updateMyIntention(bob, f.projectId, { ...privateInput, expectedRevision: 1 }), "PROJECT_ARCHIVED");
    await f.projects.removeProjectMember(alice, f.projectId, "bob", (await f.projects.getProject(alice, f.projectId)).project.revision);
    await reject(f.collaboration.getMyIntention(bob, f.projectId), "PROJECT_UNAVAILABLE");
    assert.deepEqual((await f.collaboration.getSharedIntentions(alice, f.projectId)).intentions, []);
  } finally { await f.pg.close(); }
});
test("role/rejoin changes invalidate previous consent and updating requires a fresh revision", async () => {
  const f = await setup();
  try {
    await f.collaboration.updateMyIntention(bob, f.projectId, privateInput);
    await f.projects.changeProjectRole(alice, f.projectId, "bob", { expectedRevision: (await f.projects.getProject(alice, f.projectId)).project.revision, role: "manager" });
    assert.equal((await f.collaboration.getMyIntention(bob, f.projectId)).needsConfirmation, true);
    assert.deepEqual((await f.collaboration.getSharedIntentions(alice, f.projectId)).intentions, []);
    await f.collaboration.updateMyIntention(bob, f.projectId, { ...privateInput, expectedRevision: 1 });
    assert.equal((await f.collaboration.getSharedIntentions(alice, f.projectId)).intentions[0]?.membershipRevision, 2);
    await f.projects.removeProjectMember(alice, f.projectId, "bob", (await f.projects.getProject(alice, f.projectId)).project.revision);
    const newInvite = await f.projects.createProjectInvitation(alice, f.projectId, { expectedRevision: (await f.projects.getProject(alice, f.projectId)).project.revision, role: "member" });
    await f.projects.acceptInvitation(bob, newInvite.token);
    assert.deepEqual((await f.collaboration.getSharedIntentions(alice, f.projectId)).intentions, []);
  } finally { await f.pg.close(); }
});
test("concurrent intention saves reject stale revisions without losing persisted history", async () => {
  const f = await setup();
  try {
    const results = await Promise.allSettled([f.collaboration.updateMyIntention(bob, f.projectId, privateInput), f.collaboration.updateMyIntention(bob, f.projectId, { ...privateInput, duties: ["testing"] })]);
    assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
    const failed = results.find(item => item.status === "rejected") as PromiseRejectedResult;
    assert.equal(failed.reason.code, "VERSION_CONFLICT");
    assert.equal((await f.collaboration.getMyIntention(bob, f.projectId)).intention?.revision, 1);
    const history = await f.executor.query<{ count: string }>("SELECT count(*) FROM projects_member_intention_history"); assert.equal(Number(history.rows[0]?.count), 1);
  } finally { await f.pg.close(); }
});
test("official track selection uses manager permission, current version and immutable history", async () => {
  const f = await setup();
  try {
    await reject(f.collaboration.selectTrack(bob, f.projectId, selection), "PROJECT_MANAGER_REQUIRED");
    await reject(f.collaboration.selectTrack(alice, f.projectId, { ...selection, trackId: "resource-game-package" }), "INVALID_INPUT");
    const first = await f.collaboration.selectTrack(alice, f.projectId, selection);
    assert.equal(first.selection?.trackId, "prototype"); assert.equal(first.needsReview, false); assert.equal(first.history.length, 1);
    await reject(f.collaboration.selectTrack(alice, f.projectId, selection), "VERSION_CONFLICT");
    await f.executor.query("UPDATE m03_events SET body = jsonb_set(body, '{publishedVersion}', '2') WHERE id = $1", ["event"]);
    const changed = await f.collaboration.getOfficialTracks(bob, f.projectId);
    assert.equal(changed.needsReview, true); assert.equal(changed.selection?.rulesVersion, 1);
    await reject(f.collaboration.selectTrack(alice, f.projectId, { ...selection, expectedRevision: 1 }), "TRACK_RULES_CHANGED");
    await f.executor.query("UPDATE m03_events SET body = jsonb_set(body, '{publishedVersion}', '1') WHERE id = $1", ["event"]);
    await reject(f.collaboration.selectTrack(alice, f.projectId, { ...selection, expectedRevision: 1, confirmationRevision: 2 }), "TRACK_RULES_CHANGED");
    await reject(f.collaboration.selectTrack(alice, f.projectId, { ...selection, expectedRevision: 1, eventId: "another-event" }), "TRACK_RULES_CHANGED");
    const second = await f.collaboration.selectTrack(alice, f.projectId, { ...selection, expectedRevision: 1, reason: "复核保持" });
    assert.equal(second.history.length, 2); assert.equal(second.history[1]?.reason, "本队选原型");
  } finally { await f.pg.close(); }
});
test("missing legacy tracks stay unknown; explicit no-tracks permits null selection", async () => {
  const f = await setup();
  try {
    const legacy = rules(); delete legacy.officialTracks;
    await f.executor.query("UPDATE m03_rule_versions SET body = $3::jsonb WHERE event_id = $1 AND version = $2", ["event", 1, JSON.stringify(legacy)]);
    assert.equal((await f.collaboration.getOfficialTracks(alice, f.projectId)).rules?.catalog.status, "unknown");
    await reject(f.collaboration.selectTrack(alice, f.projectId, selection), "TRACK_RULES_UNRESOLVED");
    legacy.officialTracks = { status: "none", evidenceIds: ["proof"], tracks: [] };
    await f.executor.query("UPDATE m03_rule_versions SET body = $3::jsonb WHERE event_id = $1 AND version = $2", ["event", 1, JSON.stringify(legacy)]);
    await reject(f.collaboration.selectTrack(alice, f.projectId, selection), "INVALID_INPUT");
    const view = await f.collaboration.selectTrack(alice, f.projectId, { ...selection, trackId: null });
    assert.equal(view.selection?.catalogStatus, "none"); assert.equal(view.selection?.trackId, null); assert.equal(view.needsReview, false);
  } finally { await f.pg.close(); }
});
test("failed atomic outbox write rolls back intention, history and project revision", async () => {
  const f = await setup();
  try {
    await f.pg.exec("CREATE FUNCTION fail_intention_fact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type = 'MemberIntentionChanged' THEN RAISE EXCEPTION 'simulated audit failure'; END IF; RETURN NEW; END; $$; CREATE TRIGGER fail_intention_fact BEFORE INSERT ON projects_change_fact FOR EACH ROW EXECUTE FUNCTION fail_intention_fact();");
    await assert.rejects(f.collaboration.updateMyIntention(bob, f.projectId, privateInput));
    assert.equal((await f.collaboration.getMyIntention(bob, f.projectId)).intention, null);
    assert.equal((await f.projects.getProject(alice, f.projectId)).project.revision, 3);
    const history = await f.executor.query<{ count: string }>("SELECT count(*) FROM projects_member_intention_history"); assert.equal(Number(history.rows[0]?.count), 0);
  } finally { await f.pg.close(); }
});
test("HTTP GET remains read-only; mutation guards run before input; no-store and private data projection", async () => {
  const f = await setup();
  try {
    let guarded = 0;
    const api = createProjectCollaborationHandlers({ service: f.collaboration, resolveActor: async () => bob, authorizeMutation: async () => { guarded++; throw new DomainError("CSRF_REJECTED", "来源不符", { status: 403 }); } });
    const read = await api.handle(new Request("https://example.com/projects/x/my-intention"), { kind: "myIntention", projectId: f.projectId });
    assert.equal(read.status, 200); assert.equal(read.headers.get("Cache-Control"), "private, no-store"); assert.equal(guarded, 0);
    const write = await api.handle(new Request("https://example.com/projects/x/my-intention", { method: "PUT", body: "bad-json" }), { kind: "myIntention", projectId: f.projectId });
    assert.equal(write.status, 403); assert.equal(guarded, 1);
    const anonymous = createProjectCollaborationHandlers({ service: f.collaboration, resolveActor: async () => null, authorizeMutation: async () => {} });
    assert.equal((await anonymous.handle(new Request("https://example.com"), { kind: "sharedIntentions", projectId: f.projectId })).status, 401);
    assert.equal((await f.projects.getProject(alice, f.projectId)).project.revision, 3);
  } finally { await f.pg.close(); }
});
