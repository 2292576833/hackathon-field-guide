import test from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../../shared/errors.ts";
import { createEventOfficialLinksHttpHandlers, eventOfficialLinksHttpRoute } from "./handlers.ts";
import type { EventOfficialLinksHttpRoute } from "./handlers.ts";
import { officialLinksFixture, setInput } from "./testing.ts";

const linkRoute: EventOfficialLinksHttpRoute = { kind: "link", hostedEventId: "hosted-a" };
const url = "https://field-guide.example/api/v1/admin/organizer/events/hosted-a/rule-link";
function request(method = "GET", body?: unknown, suffix = "") {
  return new Request(url + suffix, { method, ...(method === "GET" ? {} : { headers: { "Content-Type": "application/json", "Origin": "https://field-guide.example" }, body: JSON.stringify(body ?? setInput()) }) });
}
function handlers(f: Awaited<ReturnType<typeof officialLinksFixture>>) {
  let mutations = 0;
  const http = createEventOfficialLinksHttpHandlers({
    service: f.service, resolvePrincipal: async () => f.users.administrator, requestId: () => "official-link-http-test",
    authorizeMutation: async req => {
      mutations += 1;
      if (req.headers.get("origin") !== "https://field-guide.example") throw new DomainError("ORIGIN_REJECTED", "请求来源无效。", { status: 403 });
    },
  });
  return { http, mutationCount: () => mutations };
}

test("route parser accepts only the exact administrator rule-link routes and safe decoded IDs", () => {
  assert.deepEqual(eventOfficialLinksHttpRoute(["admin", "organizer", "events", "hosted-a", "rule-link"]), linkRoute);
  assert.deepEqual(eventOfficialLinksHttpRoute(["admin", "organizer", "events", "hosted-a", "rule-link", "candidates"]), { ...linkRoute, kind: "candidates" });
  assert.deepEqual(eventOfficialLinksHttpRoute(["admin", "organizer", "events", "hosted-a", "rule-link", "history"]), { ...linkRoute, kind: "history" });
  for (const path of [
    ["organizer", "events", "hosted-a", "rule-link"], ["admin", "organizer", "events", "hosted-a", "rule-links"],
    ["admin", "organizer", "events", "hosted-a", "rule-link", "history", "extra"], ["admin", "organizer", "events", "hosted-a", "rule-link", "unknown"],
    ["admin", "organizer", "events", "", "rule-link"], ["admin", "organizer", "events", "hosted-a/other", "rule-link"],
    ["admin", "organizer", "events", "hosted-a%2Fother", "rule-link"], ["admin", "organizer", "events", "' OR 1=1", "rule-link"],
  ]) assert.equal(eventOfficialLinksHttpRoute(path), null);
});

test("GET mapping, candidates and history use real service reads with private cache headers and no mutation authorization", async t => {
  const f = await officialLinksFixture(t); const h = handlers(f);
  f.statements.length = 0;
  const response = await h.http.handle(request(), linkRoute);
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("vary"), "Cookie"); assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const data = await response.json(); assert.equal(data.data.state, "unlinked"); assert.equal(data.requestId, "official-link-http-test");
  const candidates = await h.http.handle(request("GET", undefined, "/candidates?query=" + encodeURIComponent("同名")), { ...linkRoute, kind: "candidates" });
  assert.equal(candidates.status, 200); assert.deepEqual((await candidates.json()).data.map((item: { eventId: string }) => item.eventId), ["rules-a", "rules-b"]);
  const history = await h.http.handle(request("GET", undefined, "/history"), { ...linkRoute, kind: "history" });
  assert.deepEqual((await history.json()).data, []);
  assert.equal(h.mutationCount(), 0);
  assert.equal(f.statements.some(statement => /\b(?:INSERT|UPDATE|DELETE)\b|FOR UPDATE/i.test(statement)), false);
  assert.deepEqual(await f.counts(), { heads: 0, history: 0 });
});

test("HTTP PUT and DELETE preserve CAS, stale versions and tombstone history through the real SQL service", async t => {
  const f = await officialLinksFixture(t); const h = handlers(f);
  const saved = await h.http.handle(request("PUT"), linkRoute); assert.equal(saved.status, 200);
  assert.equal((await saved.json()).data.link.revision, 1);
  const retry = await h.http.handle(request("PUT"), linkRoute); assert.equal(retry.status, 409);
  const conflict = await retry.json(); assert.equal(conflict.error.code, "OFFICIAL_LINK_REVISION_CONFLICT"); assert.equal(conflict.error.latestRevision, 1); assert.ok(conflict.error.recoveryAction);
  await f.changeHosted("hosted-a", { publishedRevision: 4 });
  const stale = await h.http.handle(request("GET"), linkRoute); assert.equal((await stale.json()).data.staleReason, "hosted_version_changed");
  const wrongVersion = await h.http.handle(request("PUT", setInput({ expectedRevision: 1 })), linkRoute); assert.equal(wrongVersion.status, 409);
  const removed = await h.http.handle(request("DELETE", { expectedRevision: 1, auditNote: "旧正式规则已过期，人工撤回" }), linkRoute); assert.equal(removed.status, 200);
  assert.equal((await removed.json()).data.state, "withdrawn");
  assert.equal(h.mutationCount(), 4); assert.deepEqual(await f.counts(), { heads: 1, history: 2 });
});

test("untrusted or absent Origin is rejected before request JSON is read", async t => {
  const f = await officialLinksFixture(t); const h = handlers(f);
  for (const origin of [null, "https://attacker.example", "null"]) {
    const headers: Record<string, string> = { "Content-Type": "application/json" }; if (origin !== null) headers.Origin = origin;
    const req = new Request(url, { method: "PUT", headers, body: "{invalid-json" });
    const response = await h.http.handle(req, linkRoute);
    assert.equal(response.status, 403); assert.equal((await response.json()).error.code, "ORIGIN_REJECTED");
    assert.equal(req.bodyUsed, false);
  }
  assert.deepEqual(await f.counts(), { heads: 0, history: 0 });
});

test("JSON type, syntax, decoded shape and 16 KiB byte limit are enforced for mutations", async t => {
  const f = await officialLinksFixture(t); const h = handlers(f);
  const cases: Array<{ body: BodyInit; contentType: string; status: number; code?: string }> = [
    { body: JSON.stringify(setInput()), contentType: "text/plain", status: 415, code: "JSON_REQUIRED" },
    { body: "{broken", contentType: "application/json", status: 400, code: "INVALID_JSON" },
    { body: new Uint8Array([0xff]), contentType: "application/json", status: 400, code: "INVALID_JSON" },
    { body: "null", contentType: "application/json", status: 400 }, { body: "[]", contentType: "application/json", status: 400 },
    { body: '"text"', contentType: "application/json", status: 400 },
    { body: JSON.stringify(setInput({ auditNote: "中".repeat(6000) })), contentType: "application/json", status: 413, code: "REQUEST_TOO_LARGE" },
  ];
  for (const entry of cases) {
    const response = await h.http.handle(new Request(url, { method: "PUT", headers: { "Content-Type": entry.contentType, "Origin": "https://field-guide.example" }, body: entry.body }), linkRoute);
    assert.equal(response.status, entry.status); if (entry.code) assert.equal((await response.json()).error.code, entry.code);
  }
  const valid = await h.http.handle(new Request(url, { method: "PUT", headers: { "Content-Type": "application/json; charset=utf-8", "Origin": "https://field-guide.example" }, body: JSON.stringify(setInput()) }), linkRoute);
  assert.equal(valid.status, 200); assert.deepEqual(await f.counts(), { heads: 1, history: 1 });
});

test("mutation body whitelist prevents guessed organization, actor or source facts; IDs and integer versions remain strict", async t => {
  const f = await officialLinksFixture(t); const h = handlers(f);
  const badInputs = [
    { ...setInput(), organizationId: "org-b" }, { ...setInput(), updatedBy: "outsider" }, { ...setInput(), sourceUrl: "https://fake.example" },
    { ...setInput(), linkedEventId: "rules-a/other" }, { ...setInput(), expectedRevision: "0" }, { ...setInput(), rulesVersion: 3.5 },
  ];
  for (const body of badInputs) {
    const response = await h.http.handle(request("PUT", body), linkRoute);
    assert.ok(response.status === 400 || response.status === 422); assert.equal((await response.json()).error.code, "OFFICIAL_LINK_INVALID_INPUT");
  }
  const removeExtra = await h.http.handle(request("DELETE", { expectedRevision: 1, auditNote: "撤回", linkedEventId: "rules-b" }), linkRoute);
  assert.equal(removeExtra.status, 400);
  const invalidRoute = await h.http.handle(request(), { ...linkRoute, hostedEventId: "a/b" }); assert.equal(invalidRoute.status, 400);
  assert.deepEqual(await f.counts(), { heads: 0, history: 0 });
});

test("methods and query whitelist prevent unsupported mutation or parameter routes before service work", async t => {
  const f = await officialLinksFixture(t); const h = handlers(f);
  for (const [method, route] of [["POST", linkRoute], ["PATCH", linkRoute], ["PUT", { ...linkRoute, kind: "candidates" }], ["DELETE", { ...linkRoute, kind: "history" }]] as const) {
    const response = await h.http.handle(request(method), route); assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), route.kind === "link" ? "GET, PUT, DELETE" : "GET");
  }
  for (const [suffix, route] of [["?organizationId=org-b", linkRoute], ["?query=test", linkRoute], ["/candidates?query=a&query=b", { ...linkRoute, kind: "candidates" }], ["/candidates?query=a&limit=999", { ...linkRoute, kind: "candidates" }], ["/history?eventId=hosted-b", { ...linkRoute, kind: "history" }]] as const) {
    const response = await h.http.handle(request("GET", undefined, suffix), route); assert.equal(response.status, 400);
  }
  assert.equal(h.mutationCount(), 0); assert.equal(f.statements.length, 0); assert.deepEqual(await f.counts(), { heads: 0, history: 0 });
});

test("HTTP root principal resolution and service both enforce authentication and administrator authority", async t => {
  const f = await officialLinksFixture(t);
  for (const [principal, status] of [[null, 401], [f.users.organizer, 403], [f.users.reviewer, 403]] as const) {
    const http = createEventOfficialLinksHttpHandlers({ service: f.service, resolvePrincipal: async () => principal, authorizeMutation: async () => {} });
    for (const req of [request(), request("PUT")]) assert.equal((await http.handle(req, linkRoute)).status, status);
  }
  await f.direct.query("UPDATE auth_users SET platform_roles=$1::text[] WHERE id=$2", [["user"], "administrator"]);
  const h = handlers(f); assert.equal((await h.http.handle(request("PUT"), linkRoute)).status, 401);
  assert.deepEqual(await f.counts(), { heads: 0, history: 0 });
});

test("unknown failures expose no underlying exception, sensitive details or stack", async t => {
  const f = await officialLinksFixture(t);
  const http = createEventOfficialLinksHttpHandlers({ service: f.service, resolvePrincipal: async () => { throw new Error("PRIVATE_DATABASE_CONNECTION_DETAILS"); }, authorizeMutation: async () => {}, requestId: () => "opaque-error-request" });
  const response = await http.handle(request(), linkRoute); assert.equal(response.status, 500);
  const body = await response.json(); assert.equal(body.error.code, "INTERNAL_ERROR"); assert.equal(body.requestId, "opaque-error-request");
  assert.equal(JSON.stringify(body).includes("PRIVATE_DATABASE_CONNECTION_DETAILS"), false); assert.equal("stack" in body.error, false);
});
