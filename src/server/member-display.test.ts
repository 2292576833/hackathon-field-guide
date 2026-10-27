import test from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../shared/contracts.ts";
import type { DatabasePort } from "../shared/persistence.ts";
import { createDatabase } from "./database.ts";
import { createMemberDisplayDecorators } from "./member-display.ts";
import { memberLabel } from "../components/member-display.ts";
import { createInvitationTokens, createProjectsHttpHandlers, PostgresProjectsRepository, ProjectsService, type ProjectsHttpRoute } from "../modules/projects/index.ts";

const at = "2026-10-08T12:00:00.000Z";
const actor: Actor = { userId: "viewer", platformRoles: ["user"] };
async function fixture() {
  const database = await createDatabase({}); await database.migrate();
  for (const [id, name, status] of [
    ["viewer", "小林", "active"], ["peer", "小陈", "active"], ["duplicate", "小陈", "active"],
    ["departed", "PRIVATE_DEPARTED_NAME", "active"], ["suspended", "PRIVATE_SUSPENDED_NAME", "suspended"], ["foreign", "PRIVATE_FOREIGN_NAME", "active"],
  ]) await database.query("INSERT INTO auth_users(id,email,display_name,timezone,status,email_verified_at,created_at) VALUES($1,$2,$3,'Asia/Shanghai',$4,$5::timestamptz,$5::timestamptz)", [id, `private_${id}@example.test`, name, status, at]);
  let counter = 0;
  const service = new ProjectsService({ repository: new PostgresProjectsRepository(database), ids: { next: () => `member-fixture-${++counter}` }, clock: { now: () => new Date(at) }, tokens: createInvitationTokens() });
  const team = await service.createTeam(actor, { name: "合作队" });
  const project = await service.createProject(actor, { name: "参赛作品", teamId: team.id, timezone: "Asia/Shanghai", goal: "PRIVATE_PROJECT_GOAL" });
  for (const scope of ["project", "team"] as const) for (const id of ["peer", "duplicate", "departed", "suspended"]) {
    const status = id === "departed" ? "left" : "active", scopeId = scope === "project" ? project.id : team.id;
    await database.query(`INSERT INTO projects_${scope}_membership(membership_id,${scope}_id,user_id,role,status,revision,joined_at,left_at) VALUES($1,$2,$3,'member',$4,1,$5::timestamptz,$6::timestamptz)`, [`${scope}-${id}`, scopeId, id, status, at, status === "active" ? null : at]);
  }
  const handlers = createProjectsHttpHandlers({ service, resolveActor: async () => actor, authorizeMutation: async () => {}, requestId: () => "roster-fixture" });
  const get = (route: ProjectsHttpRoute, history = false) => handlers.handle(new Request(`http://localhost/api/v1/fixture${history ? "?history=true" : ""}`), route);
  return { database, service, project, team, get, decorators: createMemberDisplayDecorators({ database }) };
}
async function body(response: Response) { return await response.json() as { data: Record<string, any>; error?: { code: string }; requestId: string }; }

test("authorized project and team GETs project scoped display names without email or invisible users", async () => {
  const f = await fixture();
  try {
    for (const scope of ["project", "team"] as const) {
      const id = f[scope].id;
      const original = await f.get(scope === "project" ? { kind: "project", projectId: id } : { kind: "team", teamId: id });
      original.headers.set("etag", "old-body"); original.headers.set("content-length", "999");
      const response = await f.decorators[scope](actor, id, original), result = await body(response);
      assert.equal(response.status, 200); assert.equal(response.headers.get("etag"), null); assert.equal(response.headers.get("content-length"), null);
      assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.equal(result.requestId, "roster-fixture");
      assert.deepEqual(result.data.members.map((m: any) => [m.userId, m.displayName]).sort(), [["duplicate", "小陈"], ["peer", "小陈"], ["viewer", "小林"]]);
      assert.equal(result.data.membership.displayName, "小林");
      assert.doesNotMatch(JSON.stringify(result.data.members), /email|PRIVATE_|platformRoles|createdBy|password|token/);
    }
  } finally { await f.database.close(); }
});

test("history keeps exited membership facts but never enriches the former member's current name", async () => {
  const f = await fixture();
  try {
    for (const scope of ["project", "team"] as const) {
      const id = f[scope].id, response = await f.get(scope === "project" ? { kind: "projectMembers", projectId: id } : { kind: "teamMembers", teamId: id }, true);
      const data = (await body(await f.decorators[scope](actor, id, response))).data;
      const departed = data.members.find((m: any) => m.userId === "departed");
      assert.equal(departed.status, "left"); assert.equal(departed.displayName, null); assert.equal(departed.leftAt, at);
      assert.doesNotMatch(JSON.stringify(data.members), /PRIVATE_DEPARTED_NAME|PRIVATE_SUSPENDED_NAME|email/);
      assert.equal(data[`${scope}Revision`], 1);
    }
  } finally { await f.database.close(); }
});

test("errors, unrelated lists and malformed responses do not query names or change the response", async () => {
  let queries = 0;
  const database: DatabasePort = { query: async () => { queries++; throw new Error("no lookup"); }, transaction: async () => { queries++; throw new Error("no lookup"); } };
  const decorators = createMemberDisplayDecorators({ database });
  for (const response of [Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 }), Response.json({ data: [] }), Response.json({ data: { members: [] } }), new Response("broken", { headers: { "content-type": "application/json" } })]) {
    assert.equal(await decorators.project(actor, "opaque-project", response), response);
  }
  assert.equal(queries, 0);
});

test("anonymous and fresh suspended identities cannot receive an authorized handler's old body", async () => {
  const f = await fixture();
  try {
    const old = await f.get({ kind: "project", projectId: f.project.id });
    const anonymous = await f.decorators.project(null, f.project.id, old.clone());
    assert.equal(anonymous.status, 401); assert.doesNotMatch(await anonymous.text(), /PRIVATE_PROJECT_GOAL|小陈/);
    await f.database.query("UPDATE auth_users SET status='suspended' WHERE id='viewer'");
    const suspended = await f.decorators.project(actor, f.project.id, old);
    assert.equal(suspended.status, 401); assert.doesNotMatch(await suspended.text(), /PRIVATE_PROJECT_GOAL|小陈/);
  } finally { await f.database.close(); }
});

test("project or team membership withdrawal after handler authorization denies cached bodies despite actor roles", async () => {
  const f = await fixture();
  try {
    for (const scope of ["project", "team"] as const) {
      const id = f[scope].id;
      if (scope === "project") await f.service.changeProjectRole(actor, id, "peer", { expectedRevision: 1, role: "manager" });
      else await f.service.changeTeamRole(actor, id, "peer", { expectedRevision: 1, role: "captain" });
      const old = await f.get(scope === "project" ? { kind: "project", projectId: id } : { kind: "team", teamId: id });
      const peer: Actor = { userId: "peer", platformRoles: ["user"] };
      if (scope === "project") await f.service.removeProjectMember(peer, id, "viewer", 2);
      else await f.service.removeTeamMember(peer, id, "viewer", 2);
      const denied = await f.decorators[scope]({ ...actor, platformRoles: ["user", "admin"] }, id, old);
      assert.equal(denied.status, 404); assert.doesNotMatch(await denied.text(), /PRIVATE_PROJECT_GOAL|小陈|合作队/);
    }
  } finally { await f.database.close(); }
});

test("revision changes force refresh instead of mixing an old root with new member facts", async () => {
  const f = await fixture();
  try {
    const old = await f.get({ kind: "project", projectId: f.project.id });
    await f.service.editProject(actor, f.project.id, { expectedRevision: 1, goal: "新目标" });
    const result = await f.decorators.project(actor, f.project.id, old);
    assert.equal(result.status, 409); assert.equal((await body(result)).error?.code, "VERSION_CONFLICT");
  } finally { await f.database.close(); }
});

test("a user outside the scope cannot be enriched through a forged response row", async () => {
  const f = await fixture();
  try {
    const source = await body(await f.get({ kind: "project", projectId: f.project.id }));
    source.data.members.push({ ...source.data.members[0], membershipId: "foreign-member", userId: "foreign", displayName: "PRIVATE_FOREIGN_NAME", email: "PRIVATE_foreign@example.test" });
    source.data.members[1].email = "PRIVATE_peer@example.test";
    const result = await body(await f.decorators.project(actor, f.project.id, Response.json(source)));
    assert.equal(result.data.members.some((m: any) => m.userId === "foreign"), false);
    assert.doesNotMatch(JSON.stringify(result.data.members), /PRIVATE_FOREIGN_NAME|email|PRIVATE_peer/);
    const wrongScope = await f.decorators.project(actor, "different-project", Response.json(source));
    assert.equal(wrongScope.status, 404);
  } finally { await f.database.close(); }
});

test("team project links require current direct project membership, even for a team captain", async () => {
  const f = await fixture();
  try {
    const second = await f.service.createProject(actor, { name: "另一个作品", timezone: "Asia/Shanghai", teamId: f.team.id });
    await f.service.changeProjectRole(actor, f.project.id, "peer", { expectedRevision: 1, role: "manager" });
    const old = await f.get({ kind: "team", teamId: f.team.id });
    await f.service.removeProjectMember({ userId: "peer", platformRoles: ["user"] }, f.project.id, "viewer", 2);
    const result = await body(await f.decorators.team(actor, f.team.id, old));
    assert.equal(result.data.membership.role, "captain");
    assert.deepEqual(result.data.projects.map((p: any) => p.id), [second.id]);
    assert.doesNotMatch(JSON.stringify(result.data.projects), /PRIVATE_PROJECT_GOAL/);
    await f.database.query("UPDATE projects_project SET revision=revision+1,team_id=NULL WHERE id=$1", [second.id]);
    const moved = await body(await f.decorators.team(actor, f.team.id, await f.get({ kind: "team", teamId: f.team.id })));
    assert.equal(moved.data.projects.length, 0);
  } finally { await f.database.close(); }
});

test("archived project history remains readable with current member authorization", async () => {
  const f = await fixture();
  try {
    await f.service.transitionStage(actor, f.project.id, { expectedRevision: 1, stage: "archived", reason: "保留历史" });
    const result = await body(await f.decorators.project(actor, f.project.id, await f.get({ kind: "project", projectId: f.project.id })));
    assert.equal(result.data.project.stage, "archived"); assert.equal(result.data.members.find((m: any) => m.userId === "peer").displayName, "小陈");
  } finally { await f.database.close(); }
});

test("database failure returns a safe 503 and never the old private handler body or SQL details", async () => {
  const f = await fixture();
  try {
    const database: DatabasePort = { query: f.database.query, transaction: async () => { throw new Error("PRIVATE_SQL_PASSWORD https://provider-secret.invalid"); } };
    const response = await createMemberDisplayDecorators({ database }).project(actor, f.project.id, await f.get({ kind: "project", projectId: f.project.id }));
    assert.equal(response.status, 503); assert.equal(response.headers.get("cache-control"), "private, no-store");
    const text = await response.text(); assert.match(text, /MEMBER_DISPLAY_UNAVAILABLE/); assert.doesNotMatch(text, /PRIVATE_|provider-secret|小陈/);
  } finally { await f.database.close(); }
});

test("member labels preserve self, real names and stable duplicate/fallback identities across sorting and rejoining", () => {
  const a = { membershipId: "membership-a", userId: "user-a", displayName: "小陈" }, b = { membershipId: "membership-b", userId: "user-b", displayName: "小陈" };
  assert.equal(memberLabel(a, "user-a", [a, b]), "你");
  assert.equal(memberLabel(a, undefined, [a]), "小陈");
  const label = memberLabel(a, undefined, [a, b]);
  assert.match(label, /^小陈 · [A-Z0-9]{7}$/); assert.notEqual(label, memberLabel(b, undefined, [a, b]));
  assert.equal(label, memberLabel(a, undefined, [b, a]));
  assert.equal(label, memberLabel({ ...a, membershipId: "new-membership" }, undefined, [a, b]));
  const fallback = memberLabel({ ...a, displayName: null }); assert.match(fallback, /^队友 · [A-Z0-9]{7}$/);
  assert.doesNotMatch(fallback, /user-a|membership-a/);
  assert.equal(memberLabel({ ...a, displayName: " \u0000小\n陈 " }), "小 陈");
});
