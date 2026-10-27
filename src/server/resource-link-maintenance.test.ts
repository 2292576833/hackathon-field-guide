import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { SqlExecutor } from "../shared/persistence.ts";
import { DomainError } from "../shared/errors.ts";
import { createDatabase } from "./database.ts";
import { createResourceLinkMaintenance } from "./resource-link-maintenance.ts";
import type { ResourceLinkTransport } from "../modules/resources/link-check-worker.ts";
import type { PinnedFetchRequest, PinnedFetchResponse } from "../modules/operations/network-policy.ts";

const start = "2026-10-10T09:00:00.000Z";
async function fixture(t: TestContext) {
  const database = await createDatabase({}); t.after(() => database.close());
  await database.migrate();
  if (!(await database.query("SELECT to_regclass('resource_link_maintenance_state') AS table_name")).rows[0]!.table_name) {
    const schema = await readFile(new URL("./resource-link-maintenance.sql", import.meta.url), "utf8");
    for (const statement of schema.split(";").filter(value => value.trim())) await database.query(statement);
  }
  let now = Date.parse(start);
  const clock = { now: () => new Date(now) }, advance = (ms: number) => { now += ms; };
  await database.query("INSERT INTO auth_users(id,email,display_name,timezone,platform_roles,email_verified_at,created_at) VALUES('operator','isolated@example.test','fixture','UTC',ARRAY['user','admin']::text[],$1::timestamptz,$1::timestamptz)", [start]);
  await database.query("INSERT INTO auth_sessions(id,user_id,token_hash,created_at,authenticated_at,expires_at) VALUES('session','operator',$1,$2::timestamptz,$2::timestamptz,$2::timestamptz+interval '30 days')", ["a".repeat(64), start]);
  const principal = { actor: {userId: "operator", platformRoles: ["admin" as const]}, guard: async (sql: SqlExecutor) => {
    const fresh = await sql.query("SELECT id FROM auth_sessions WHERE id='session' AND user_id='operator' AND revoked_at IS NULL AND expires_at>$1::timestamptz FOR SHARE", [clock.now().toISOString()]);
    if (!fresh.rowCount) throw new DomainError("UNAUTHENTICATED", "登录已失效。", {status: 401});
  } };
  const calls: string[] = [], robots: string[] = [];
  let response: (url: string, signal: AbortSignal) => ReturnType<ResourceLinkTransport["head"]> = async () => ({statusCode: 200, location: null});
  let robotsResponse: (input: PinnedFetchRequest) => Promise<PinnedFetchResponse> = async input => ({status: 200, connectedAddress: input.connectAddress, contentType: "text/plain", body: "User-agent: *\nAllow: /"});
  let addresses = ["93.184.216.34"];
  const network = {dns: {resolve: async () => addresses}, transport: {request: async (input: PinnedFetchRequest) => { robots.push(input.url); return robotsResponse(input); }}};
  const headTransport: ResourceLinkTransport = {head: async (url, signal) => { calls.push(url); return response(url, signal); }};
  const make = (options: {batchSize?: number; timeoutMs?: number} = {}) => createResourceLinkMaintenance({database, clock, network, headTransport, resolvePrincipal: async () => principal, requestId: () => "fixture-request", ...options});
  async function add(id: string, url = `https://${id}.hackathon.dev/guide`, overrides: {publication?: string; blocked?: boolean; review?: boolean; reviewUrl?: string} = {}) {
    const doc = {id,revision: 2,version: 1,publicationStatus: overrides.publication ?? "published",externalLinkBlocked: overrides.blocked ?? false,officialUrl: url,reviewId: `review-${id}`};
    await database.query("INSERT INTO resource_records(id,revision,working_document,public_document) VALUES($1,2,$2::jsonb,$2::jsonb)", [id, JSON.stringify(doc)]);
    if (overrides.review !== false) {
      const review = {id: `review-${id}`,resourceId: id,resourceRevision: 1,revision: 2,status: "published",publishedVersion: 1,verification: {link: {status: "available",checkedUrl: overrides.reviewUrl ?? url}}};
      await database.query("INSERT INTO operations_resource_reviews(id,resource_id,resource_revision,revision,status,updated_at,payload) VALUES($1,$2,1,2,'published',$3::timestamptz,$4::jsonb)", [`review-${id}`, id, start, JSON.stringify(review)]);
    }
  }
  return {database, clock, advance, principal, calls, robots, make, add, setHead: (fn: typeof response) => {response = fn;}, setRobots: (fn: typeof robotsResponse) => {robotsResponse = fn;}, setDns: (values: string[]) => {addresses = values;}};
}

test("admin GET remains read-only, validates current account/session and persists only actual approved-version checks", async t => {
  const f = await fixture(t), worker = f.make();
  assert.equal((await worker.handlers.status(new Request("https://site.test/status"))).status, 200);
  assert.equal((await f.database.query("SELECT id FROM resource_link_maintenance_state")).rowCount, 0);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.robots, []);
  await f.add("approved"); await f.add("seed", undefined, {review: false}); await f.add("blocked", undefined, {blocked: true});
  await f.add("mismatch", undefined, {reviewUrl: "https://other.hackathon.dev/guide"});
  const before = JSON.stringify((await f.database.query("SELECT * FROM resource_records ORDER BY id")).rows);
  assert.equal((await worker.runOnce()).checked, 1);
  assert.deepEqual(f.calls, ["https://approved.hackathon.dev/guide"]);
  assert.deepEqual(f.robots, ["https://approved.hackathon.dev/robots.txt"]);
  assert.equal(JSON.stringify((await f.database.query("SELECT * FROM resource_records ORDER BY id")).rows), before);
  const status = await worker.status(f.principal); assert.equal(status.results[0]!.status, "available");
  assert.doesNotMatch(JSON.stringify(status), /review-|token|isolated@example|officialUrl|lease_token/);
  await f.database.query("UPDATE auth_sessions SET revoked_at=$1::timestamptz WHERE id='session'", [start]);
  await assert.rejects(worker.status(f.principal), {code: "UNAUTHENTICATED"});
  await f.database.query("UPDATE auth_users SET platform_roles=ARRAY['user']::text[] WHERE id='operator'");
  await assert.rejects(worker.status(f.principal), {code: "FORBIDDEN"});
});

test("website 24-hour interval and small batches survive factory recreation", async t => {
  const f = await fixture(t);
  await f.add("one", "https://shared.hackathon.dev/one"); await f.add("two", "https://shared.hackathon.dev/two"); await f.add("other");
  assert.equal((await f.make({batchSize: 1}).runOnce()).checked, 1);
  f.advance(61000);
  assert.equal((await f.make({batchSize: 1}).runOnce()).checked, 1);
  f.advance(61000);
  assert.equal((await f.make().runOnce()).checked, 0);
  assert.equal(f.calls.length, 2);
  f.advance(86400000);
  assert.equal((await f.make().runOnce()).checked, 2);
  assert.equal(f.calls.length, 4);
});

test("robots denial, private DNS and unavailable robots never reach HEAD or modify publication", async t => {
  const f = await fixture(t); await f.add("denied");
  f.setRobots(async input => ({status: 200, connectedAddress: input.connectAddress, contentType: "text/plain",body: "User-agent: *\nDisallow: /"}));
  await f.make().runOnce();
  assert.equal((await f.make().status(f.principal)).results[0]!.reason, "robots_disallowed"); assert.equal(f.calls.length, 0);
  await f.add("private"); f.setDns(["127.0.0.1"]); f.advance(61000); await f.make().runOnce();
  assert.equal(f.calls.length, 0); assert.equal((await f.make().status(f.principal)).results[0]!.status, "unknown");
  const resources = (await f.database.query<{publication: string}>("SELECT public_document->>'publicationStatus' AS publication FROM resource_records")).rows;
  assert.ok(resources.every(item => item.publication === "published"));
});

test("exact-approved redirect rechecks robots and reserves target website; external redirect never leaves whitelist", async t => {
  const f = await fixture(t); await f.add("origin"); await f.add("target");
  f.setHead(async url => url.includes("origin.") ? {statusCode: 302,location: "https://target.hackathon.dev/guide"} : {statusCode: 200,location: null});
  const report = await f.make().runOnce(); assert.equal(report.checked, 1);
  assert.deepEqual(f.robots, ["https://origin.hackathon.dev/robots.txt", "https://target.hackathon.dev/robots.txt"]);
  assert.equal((await f.database.query("SELECT hostname FROM resource_link_maintenance_sites")).rowCount, 2);
  f.advance(86461000); f.setHead(async () => ({statusCode: 302,location: "https://unapproved.hackathon.dev/private"}));
  await f.make().runOnce(); assert.ok(!f.calls.some(url => url.includes("unapproved")));
  assert.equal((await f.make().status(f.principal)).results.find(item => item.resourceId === "origin")!.reason, "redirect_not_approved");
});

test("changed resource revision and expired worker lease cannot write old results", async t => {
  const f = await fixture(t); await f.add("changed");
  f.setHead(async () => {
    await f.database.query("UPDATE resource_records SET revision=3,working_document=jsonb_set(working_document,'{revision}','3'::jsonb) WHERE id='changed'");
    return {statusCode: 200,location: null};
  });
  const first = await f.make().runOnce(); assert.equal(first.checked, 0); assert.equal(first.skippedChanged, 1);
  assert.equal((await f.database.query("SELECT resource_id FROM resource_link_check_results")).rowCount, 0);
  await f.add("expired"); f.advance(61000);
  f.setHead(async () => {f.advance(180000);return {statusCode: 200,location: null};});
  assert.equal((await f.make().runOnce()).checked, 0);
  assert.equal((await f.make().status(f.principal)).state?.phase, "stale");
});

test("concurrent workers admit one lease, and request timeout is unknown without delisting", async t => {
  const f = await fixture(t); await f.add("only");
  let started!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => {started = resolve;}), release = new Promise<void>(resolve => {finish = resolve;});
  f.setHead(async () => {started();await release;return {statusCode: 200,location: null};});
  const one = f.make().runOnce(); await entered;
  assert.equal((await f.make().runOnce()).status, "busy"); finish(); await one;
  assert.equal(f.calls.length, 1);
  await f.add("timeout"); f.advance(61000); f.setHead(async () => new Promise(() => {}));
  const second = await f.make({timeoutMs: 100}).runOnce(); assert.equal(second.checked, 1);
  const result = (await f.make().status(f.principal)).results.find(item => item.resourceId === "timeout")!;
  assert.equal(result.status, "unknown"); assert.equal(result.reason, "request_timeout");
  assert.equal((await f.database.query("SELECT public_document->>'publicationStatus' AS status FROM resource_records WHERE id='timeout'")).rows[0]!.status, "published");
});

test("each cycle whitelist contains at most 100 real approved URLs", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 101; i++) await f.add(`entry-${String(i).padStart(3,"0")}`);
  f.setHead(async () => ({statusCode: 302,location: "https://entry-100.hackathon.dev/guide"}));
  assert.equal((await f.make({batchSize: 1}).runOnce()).checked, 1);
  assert.deepEqual(f.calls, ["https://entry-000.hackathon.dev/guide"]);
  assert.equal((await f.make().status(f.principal)).results[0]!.reason, "redirect_not_approved");
});
