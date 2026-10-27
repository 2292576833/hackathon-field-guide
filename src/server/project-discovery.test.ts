import test from "node:test";
import assert from "node:assert/strict";
import { createApplication, type Application } from "./application.ts";
import { createDatabase } from "./database.ts";
import { dispatch } from "./router.ts";
import type { DiscoveryInput } from "./discovery.ts";
import type { ProjectDiscoveryView } from "./project-discovery.ts";
import type { Project } from "../modules/projects/index.ts";

const origin = "http://localhost:3000";
interface Identity { userId: string; cookie: string }
async function request<T>(app: Application, path: string, method = "GET", body?: unknown, identity?: Identity, expectedStatus = 200, requestOrigin = origin) {
  const response = await dispatch(app, new Request(`${origin}/api/v1/${path}`, { method, headers: { origin: requestOrigin, "content-type": "application/json", ...(identity ? { cookie: identity.cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), path.split("/"));
  const envelope = await response.json() as { data: T; error?: { code: string } };
  assert.equal(response.status, expectedStatus, `${method} isolated endpoint returned ${envelope.error?.code ?? "unexpected status"}`);
  return { data: envelope.data, error: envelope.error, response };
}
async function login(app: Application, email: string): Promise<Identity> {
  const challenge = (await request<{ challengeId: string }>(app, "auth/login-challenges", "POST", { email })).data;
  const mail = await app.database.query<{ body: string }>("SELECT body FROM development_mailbox WHERE recipient=$1 ORDER BY created_at DESC LIMIT 1", [email]);
  const code = mail.rows[0]?.body.match(/\b\d{8}\b/)?.[0]; assert.ok(code);
  const result = await request<{ profile: { id: string } }>(app, "auth/login-challenges/verify", "POST", { challengeId: challenge.challengeId, code });
  const cookie = result.response.headers.get("set-cookie")?.split(";", 1)[0]; assert.ok(cookie);
  return { userId: result.data.profile.id, cookie };
}
function card(url: string, title = "隔离自动赛事线索"): DiscoveryInput {
  const now = new Date().toISOString();
  const closesAt = new Date(Date.parse(now) + 72 * 60 * 60_000).toISOString(), evidence = `报名开放，报名截止时间为 ${closesAt}。`;
  return { canonicalUrl: url, title, summary: "DSH 发现的未核验比赛，报名日期仍需核实。", analysis: { fit: ["适合原型实践"], risks: ["报名日期没有完整证据"], preparation: ["准备可演示的作品"], unknowns: ["提交日期与费用"] }, sources: [{ url, title: "公开比赛原文", excerpt: evidence, fetchedAt: now }], discoveredAt: now, lastAnalyzedAt: now, provider: "dsh",
    registrationWindow: { status: "open", closesAt, closesOn: null, evidence: [evidence], checkedAt: now } };
}
async function fixture() {
  const database = await createDatabase({});
  try {
    const app = await createApplication({ mode: "local", origin, codePepper: "discovery-draft-test-pepper-at-least-32", emailFrom: "test@localhost.invalid" }, database);
    const manager = await login(app, "discovery-manager@example.test"), member = await login(app, "discovery-member@example.test"), stranger = await login(app, "discovery-stranger@example.test");
    const deadline = new Date(Date.now() + 72 * 60 * 60_000).toISOString();
    const project = (await request<Project>(app, "projects", "POST", { name: "赛事线索草案项目", timezone: "Asia/Shanghai", goal: "完成最小作品", deadline }, manager, 201)).data;
    const invitation = (await request<{ token: string }>(app, `projects/${project.id}/invitations`, "POST", { expectedRevision: project.revision, role: "member", invitedEmail: "discovery-member@example.test" }, manager, 201)).data;
    await request(app, `invitations/${invitation.token}/accept`, "POST", {}, member);
    const foreignProject = (await request<Project>(app, "projects", "POST", { name: "不可访问的其他项目", timezone: "Asia/Shanghai" }, stranger, 201)).data;
    const first = await app.discoveries.save(card("https://example.com/discovery-fixture/first"));
    const second = await app.discoveries.save(card("https://example.com/discovery-fixture/second", "另一项隔离赛事"));
    const path = `projects/${project.id}/discovery-draft`;
    const command = { discoveryId: first.id, discoveryRevision: first.revision, expectedRevision: 0, notes: "先核实报名条件" };
    return { app, database, manager, member, stranger, project, foreignProject, first, second, path, command };
  } catch (error) { await database.close(); throw error; }
}

test("discovery draft HTTP boundary permits project reads and manager writes without exposing foreign projects", async () => {
  const f = await fixture();
  try {
    await request(f.app, f.path, "GET", undefined, undefined, 401);
    await request(f.app, f.path, "POST", f.command, undefined, 401);
    await request(f.app, f.path, "POST", f.command, f.manager, 403, "https://untrusted.example.test");
    await request(f.app, f.path, "PUT", {}, f.manager, 405);
    await request(f.app, f.path, "GET", undefined, f.stranger, 404);
    await request(f.app, `projects/${f.foreignProject.id}/discovery-draft`, "GET", undefined, f.manager, 404);
    const denied = await request(f.app, f.path, "POST", f.command, f.member, 403);
    assert.equal(denied.error?.code, "PROJECT_MANAGER_REQUIRED");
    await request(f.app, f.path, "DELETE", { expectedRevision: 0 }, f.member, 403);
    assert.deepEqual((await request<ProjectDiscoveryView>(f.app, f.path, "GET", undefined, f.member)).data, { revision: 0, draft: null, sourceState: null });
    assert.equal((await f.database.query("SELECT project_id FROM project_discovery_drafts")).rowCount, 0);
    const saved = (await request<ProjectDiscoveryView>(f.app, f.path, "POST", f.command, f.manager)).data;
    assert.deepEqual((await request<ProjectDiscoveryView>(f.app, f.path, "GET", undefined, f.member)).data, saved);
    assert.equal(saved.draft?.savedBy, f.manager.userId);
  } finally { await f.database.close(); }
});

test("discovery draft preserves the server snapshot and CAS history across replacement and clearing without confirming rules", async () => {
  const f = await fixture();
  try {
    const before = (await request<{ project: Project }>(f.app, `projects/${f.project.id}`, "GET", undefined, f.manager)).data.project;
    const source = await f.app.discoveries.get(f.first.id);
    const first = (await request<ProjectDiscoveryView>(f.app, f.path, "POST", f.command, f.manager)).data;
    assert.equal(first.revision, 1); assert.equal(first.sourceState, "current");
    assert.deepEqual(first.draft?.snapshot, source); assert.equal(first.draft?.status, "draft");
    assert.equal(first.draft?.snapshot.verificationStatus, "unverified");
    assert.equal(await f.app.eventsRepository.getConfirmation(f.project.id), null);
    assert.deepEqual((await request<{ project: Project }>(f.app, `projects/${f.project.id}`, "GET", undefined, f.manager)).data.project, before);
    const outcomes = await Promise.all(["甲", "乙"].map(notes => dispatch(f.app, new Request(`${origin}/api/v1/${f.path}`, { method: "POST", headers: { origin, "content-type": "application/json", cookie: f.manager.cookie }, body: JSON.stringify({ ...f.command, expectedRevision: 1, notes }) }), f.path.split("/"))));
    assert.deepEqual(outcomes.map(response => response.status).sort(), [200, 409]);
    const loser = outcomes.find(response => response.status === 409)!;
    assert.equal((await loser.json()).error.code, "DISCOVERY_DRAFT_CHANGED");
    const second = (await request<ProjectDiscoveryView>(f.app, f.path, "POST", { ...f.command, discoveryId: f.second.id, discoveryRevision: f.second.revision, expectedRevision: 2, notes: "换一场比赛" }, f.manager)).data;
    assert.equal(second.revision, 3); assert.equal(second.draft?.snapshot.title, "另一项隔离赛事");
    const cleared = (await request<ProjectDiscoveryView>(f.app, f.path, "DELETE", { expectedRevision: 3 }, f.manager)).data;
    assert.deepEqual(cleared, { revision: 4, draft: null, sourceState: null });
    assert.deepEqual((await request<ProjectDiscoveryView>(f.app, f.path, "DELETE", { expectedRevision: 4 }, f.manager)).data, cleared);
    for (const stale of [0, 1, 3]) {
      const conflict = await request(f.app, f.path, "POST", { ...f.command, expectedRevision: stale }, f.manager, 409);
      assert.equal(conflict.error?.code, "DISCOVERY_DRAFT_CHANGED");
    }
    const history = await f.database.query<{ revision: number; body: ProjectDiscoveryView["draft"] }>("SELECT revision,body FROM project_discovery_draft_versions WHERE project_id=$1 ORDER BY revision", [f.project.id]);
    assert.deepEqual(history.rows.map(item => item.revision), [1, 2, 3, 4]);
    assert.deepEqual(history.rows[0]?.body?.snapshot, source); assert.equal(history.rows[3]?.body, null);
    assert.equal(await f.app.eventsRepository.getConfirmation(f.project.id), null);
    assert.deepEqual((await request<{ project: Project }>(f.app, `projects/${f.project.id}`, "GET", undefined, f.manager)).data.project, before);
  } finally { await f.database.close(); }
});

test("updated or withdrawn discoveries retain the saved evidence and require a fresh explicit choice", async () => {
  const f = await fixture();
  try {
    const saved = (await request<ProjectDiscoveryView>(f.app, f.path, "POST", f.command, f.manager)).data;
    const updated = await f.app.discoveries.save(card("https://example.com/discovery-fixture/first", "来源已更新的比赛"));
    assert.equal(updated.revision, 2);
    const changed = (await request<ProjectDiscoveryView>(f.app, f.path, "GET", undefined, f.manager)).data;
    assert.equal(changed.sourceState, "changed"); assert.deepEqual(changed.draft, saved.draft);
    const stale = await request(f.app, f.path, "POST", { ...f.command, expectedRevision: 1 }, f.manager, 409);
    assert.equal(stale.error?.code, "DISCOVERY_CHANGED");
    assert.equal((await f.database.query("SELECT revision FROM project_discovery_draft_versions")).rowCount, 1);
    const refreshed = (await request<ProjectDiscoveryView>(f.app, f.path, "POST", { ...f.command, discoveryRevision: updated.revision, expectedRevision: 1 }, f.manager)).data;
    assert.equal(refreshed.draft?.snapshot.title, "来源已更新的比赛"); assert.equal(refreshed.sourceState, "current");
    // Explicit isolated operations fixture: no production card or review is changed.
    await f.database.query("UPDATE event_discovery_cards SET status='withdrawn' WHERE id=$1", [f.first.id]);
    const unavailable = (await request<ProjectDiscoveryView>(f.app, f.path, "GET", undefined, f.member)).data;
    assert.equal(unavailable.sourceState, "unavailable"); assert.deepEqual(unavailable.draft, refreshed.draft);
    const withdrawn = await request(f.app, f.path, "POST", { ...f.command, discoveryRevision: 2, expectedRevision: 2 }, f.manager, 404);
    assert.equal(withdrawn.error?.code, "DISCOVERY_UNAVAILABLE");
    await request(f.app, f.path, "DELETE", { expectedRevision: 2 }, f.manager);
  } finally { await f.database.close(); }
});

test("discovery draft validation cannot accept fabricated snapshots, future source revisions or unbounded notes", async () => {
  const f = await fixture();
  try {
    const invalid = [null, [], {}, { ...f.command, snapshot: { verificationStatus: "verified" } }, { ...f.command, notes: "x".repeat(4001) }, { ...f.command, notes: "bad\u0000" }, { ...f.command, notes: null }, { ...f.command, discoveryId: "invalid" }, { ...f.command, discoveryRevision: 0 }, { ...f.command, discoveryRevision: 1.5 }, { ...f.command, expectedRevision: -1 }, { ...f.command, expectedRevision: "0" }];
    for (const body of invalid) assert.equal((await request(f.app, f.path, "POST", body, f.manager, 400)).error?.code, "INVALID_DISCOVERY_DRAFT");
    for (const body of [null, {}, { expectedRevision: 0, snapshot: {} }, { expectedRevision: 1.5 }]) assert.equal((await request(f.app, f.path, "DELETE", body, f.manager, 400)).error?.code, "INVALID_DISCOVERY_DRAFT");
    assert.equal((await request(f.app, f.path, "POST", { ...f.command, discoveryRevision: 9 }, f.manager, 409)).error?.code, "DISCOVERY_CHANGED");
    assert.equal((await request(f.app, f.path, "POST", { ...f.command, discoveryId: "a".repeat(64) }, f.manager, 404)).error?.code, "DISCOVERY_UNAVAILABLE");
    assert.equal((await f.database.query("SELECT project_id FROM project_discovery_drafts")).rowCount, 0);
    const trimmed = (await request<ProjectDiscoveryView>(f.app, f.path, "POST", { ...f.command, notes: "  检查原文\n报名条件  " }, f.manager)).data;
    assert.equal(trimmed.draft?.notes, "检查原文\n报名条件");
  } finally { await f.database.close(); }
});

test("archived project keeps discovery history readable and rejects save and clear", async () => {
  const f = await fixture();
  try {
    const saved = (await request<ProjectDiscoveryView>(f.app, f.path, "POST", f.command, f.manager)).data;
    const detail = (await request<{ project: Project }>(f.app, `projects/${f.project.id}`, "GET", undefined, f.manager)).data;
    await request(f.app, `projects/${f.project.id}/stage`, "POST", { expectedRevision: detail.project.revision, stage: "archived", reason: "停止本轮备赛" }, f.manager);
    assert.equal((await request(f.app, f.path, "POST", { ...f.command, expectedRevision: 1 }, f.manager, 409)).error?.code, "PROJECT_ARCHIVED");
    assert.equal((await request(f.app, f.path, "DELETE", { expectedRevision: 1 }, f.manager, 409)).error?.code, "PROJECT_ARCHIVED");
    assert.deepEqual((await request<ProjectDiscoveryView>(f.app, f.path, "GET", undefined, f.member)).data, saved);
    assert.equal((await f.database.query("SELECT revision FROM project_discovery_draft_versions")).rowCount, 1);
  } finally { await f.database.close(); }
});

test("removed members, revoked sessions and unavailable accounts lose discovery access", async () => {
  const f = await fixture();
  try {
    await request(f.app, f.path, "POST", f.command, f.manager);
    const detail = (await request<{ project: Project }>(f.app, `projects/${f.project.id}`, "GET", undefined, f.manager)).data;
    await request(f.app, `projects/${f.project.id}/members/${f.member.userId}`, "DELETE", { expectedRevision: detail.project.revision }, f.manager);
    await request(f.app, f.path, "GET", undefined, f.member, 404);
    await f.database.query("UPDATE auth_users SET status='suspended' WHERE id=$1", [f.manager.userId]);
    await request(f.app, f.path, "GET", undefined, f.manager, 401);
    await request(f.app, f.path, "DELETE", { expectedRevision: 1 }, f.manager, 401);
    // Restore only the isolated verified-account fixture to exercise normal logout.
    await f.database.query("UPDATE auth_users SET status='active' WHERE id=$1", [f.manager.userId]);
    await request(f.app, "auth/logout", "POST", {}, f.manager);
    await request(f.app, f.path, "GET", undefined, f.manager, 401);
    await request(f.app, f.path, "POST", { ...f.command, expectedRevision: 1 }, f.manager, 401);
    assert.equal((await f.database.query("SELECT revision FROM project_discovery_draft_versions")).rowCount, 1);
  } finally { await f.database.close(); }
});

test("session revocation after initial HTTP authentication is rechecked before the draft transaction", async () => {
  const f = await fixture();
  try {
    const resolve = f.app.resolveActor;
    f.app.resolveActor = async request => {
      const actor = await resolve(request);
      if (actor) await f.database.query("UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1", [actor.userId]);
      return actor;
    };
    const rejected = await request(f.app, f.path, "POST", f.command, f.manager, 401);
    assert.equal(rejected.error?.code, "UNAUTHENTICATED");
    assert.equal((await f.database.query("SELECT project_id FROM project_discovery_drafts")).rowCount, 0);
  } finally { await f.database.close(); }
});
