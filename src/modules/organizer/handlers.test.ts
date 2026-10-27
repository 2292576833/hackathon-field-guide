import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../shared/errors.ts";
import { createOrganizerHttpHandlers, organizerHttpRoute } from "./handlers.ts";
import type { OrganizerHttpRoute } from "./handlers.ts";
import { applicationInput, configurationOf, eventConfiguration, organizerFixture } from "./testing.ts";

const read = (value: Response) => value.json() as Promise<{ data?: unknown; requestId: string; error?: { code: string; message: string; latestRevision?: number; recoveryAction?: string } }>;
const request = (method = "GET", body?: unknown, headers: Record<string, string> = {}) => new Request("https://organizer.local/api/v1/test", {
  method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } }),
});

test("route selector recognizes exact public and authenticated paths, rejecting unsupported paths", () => {
  const cases: readonly [string, OrganizerHttpRoute][] = [
    ["organizer/applications", { kind: "applications" }], ["organizer/applications/mine", { kind: "mineApplications" }],
    ["admin/organizer/applications", { kind: "reviewApplications" }], ["admin/organizer/applications/a/review", { kind: "reviewApplication", applicationId: "a" }],
    ["organizer/organizations/o/events", { kind: "organizationEvents", organizationId: "o" }],
    ["organizer/organizations/o/staff-grants", { kind: "staffGrants", organizationId: "o" }],
    ["organizer/staff-grants/g/revoke", { kind: "revokeGrant", grantId: "g" }],
    ["organizer/events/e/publish", { kind: "publish", eventId: "e" }], ["organizer/events/e/publication-changes", { kind: "publicationChanges", eventId: "e" }],
    ["organizer/events/e/responsible", { kind: "responsible", eventId: "e" }],
    ["competitions", { kind: "competitions" }], ["competitions/e", { kind: "competition", eventId: "e" }], ["me/competition-identities", { kind: "identities" }],
  ];
  for (const [path, expected] of cases) assert.deepEqual(organizerHttpRoute(path.split("/")), expected);
  for (const path of ["", "__proto__", "organizer/events/e/__proto__", "organizer/events/e/unknown", "competitions/e/history", "admin/organizer/applications/a/approve", "organizer/organizations/o/events/e"]) assert.equal(organizerHttpRoute(path.split("/")), null);
});

test("public GET routes never authenticate, guard, initiate mutations or change persisted records", async t => {
  const c = await organizerFixture(t), a = await c.approvedOrganization(), event = await c.publish(await c.createEvent(a.organization.id, a.principal), a.principal);
  const before = await c.counts(), guardBefore = [...c.guardCalls], statementStart = c.statements.length;
  let authenticationCalls = 0, mutationCalls = 0;
  const handler = createOrganizerHttpHandlers({ service: c.service, authenticate: async () => { authenticationCalls++; throw new Error("public authentication must never run"); }, authorizeMutation: async () => { mutationCalls++; }, requestId: () => "http-public" });
  for (const route of [{ kind: "templates" }, { kind: "competitions" }, { kind: "competition", eventId: event.eventId }] as const) {
    const response = await handler.handle(request(), route);
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal((await read(response)).requestId, "http-public");
  }
  assert.equal(authenticationCalls, 0); assert.equal(mutationCalls, 0); assert.deepEqual([...c.guardCalls], guardBefore);
  assert.equal(c.statements.slice(statementStart).some(sql => /^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(sql)), false);
  assert.deepEqual(await c.counts(), before);
});

test("private GET uses verified principal and checks current session twice without mutation authorization", async t => {
  const c = await organizerFixture(t); await c.service.createApplication(c.users.ownerA, applicationInput());
  let authenticationCalls = 0, mutationCalls = 0;
  const handler = createOrganizerHttpHandlers({ service: c.service, authenticate: async () => { authenticationCalls++; return c.users.ownerA; }, authorizeMutation: async () => { mutationCalls++; }, requestId: () => "http-private" });
  const guardBefore = c.guardCalls.get("ownerA") ?? 0, before = await c.counts();
  const success = await handler.handle(request(), { kind: "mineApplications" });
  assert.equal(success.status, 200); assert.equal((c.guardCalls.get("ownerA") ?? 0) - guardBefore, 2);
  assert.equal(authenticationCalls, 1); assert.equal(mutationCalls, 0); assert.deepEqual(await c.counts(), before);
  await c.direct.query("UPDATE organizer_test_sessions SET active=false WHERE user_id='ownerA'");
  const expired = await handler.handle(request(), { kind: "mineApplications" });
  assert.equal(expired.status, 401); assert.equal((await read(expired)).error?.code, "AUTH_SESSION_INVALID"); assert.deepEqual(await c.counts(), before);
});

test("mutation Origin/CSRF hook rejects before parsing body or performing a service write", async t => {
  const c = await organizerFixture(t), before = await c.counts(); let mutationCalls = 0;
  const handler = createOrganizerHttpHandlers({ service: c.service, authenticate: async () => c.users.ownerA, authorizeMutation: async () => { mutationCalls++; throw new DomainError("ORIGIN_FORBIDDEN", "请从网站表单提交。", { status: 403 }); }, requestId: () => "http-origin" });
  const invalidBody = new Request("https://organizer.local/api/v1/test", { method: "POST", body: "not JSON", headers: { "content-type": "application/json", origin: "https://untrusted.org" } });
  const response = await handler.handle(invalidBody, { kind: "applications" });
  assert.equal(response.status, 403); assert.equal((await read(response)).error?.code, "ORIGIN_FORBIDDEN");
  assert.equal(mutationCalls, 1); assert.equal(c.guardCalls.size, 0); assert.equal(invalidBody.bodyUsed, false); assert.deepEqual(await c.counts(), before);
});

test("request body limits validate declared and actual bytes, media type, JSON and UTF-8", async t => {
  const c = await organizerFixture(t), before = await c.counts();
  const handler = createOrganizerHttpHandlers({ service: c.service, authenticate: async () => c.users.ownerA, authorizeMutation: async () => {}, requestId: () => "http-body" });
  const cases: readonly [Request, number, string][] = [
    [new Request("https://organizer.local", { method: "POST", body: "{}", headers: { "content-type": "application/json", "content-length": String(96 * 1024 + 1) } }), 413, "REQUEST_TOO_LARGE"],
    [new Request("https://organizer.local", { method: "POST", body: JSON.stringify({ text: "字".repeat(40_000) }), headers: { "content-type": "application/json", "content-length": "1" } }), 413, "REQUEST_TOO_LARGE"],
    [new Request("https://organizer.local", { method: "POST", body: "{}", headers: { "content-type": "text/plain" } }), 415, "UNSUPPORTED_MEDIA_TYPE"],
    [new Request("https://organizer.local", { method: "POST", body: "{", headers: { "content-type": "application/json" } }), 400, "INVALID_JSON"],
    [new Request("https://organizer.local", { method: "POST", headers: { "content-type": "application/json" } }), 400, "INVALID_JSON"],
    [new Request("https://organizer.local", { method: "POST", body: new Uint8Array([0xff]), headers: { "content-type": "application/json" } }), 400, "INVALID_JSON"],
  ];
  for (const [input, status, code] of cases) {
    const response = await handler.handle(input, { kind: "applications" });
    assert.equal(response.status, status); assert.equal((await read(response)).error?.code, code);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
  assert.deepEqual(await c.counts(), before); assert.equal(c.guardCalls.size, 0);
});

test("HTTP bodies cannot supply actors, platform roles or an untrusted M03 event link", async t => {
  const c = await organizerFixture(t), a = await c.approvedOrganization(), before = await c.counts();
  const handler = createOrganizerHttpHandlers({ service: c.service, authenticate: async () => c.users.ownerA, authorizeMutation: async () => {}, requestId: () => "http-spoofing" });
  for (const body of [{ ...applicationInput(), actor: { userId: "administrator", platformRoles: ["admin"] } }, { ...applicationInput(), platformRoles: ["admin"] }]) {
    const response = await handler.handle(request("POST", body), { kind: "applications" });
    assert.equal(response.status, 422); assert.equal((await read(response)).error?.code, "ORGANIZER_INPUT_INVALID");
  }
  const eventResponse = await handler.handle(request("POST", { ...eventConfiguration(), templateKey: "online", expectedOrganizationRevision: a.organization.revision, linkedEventId: "unverified-link" }), { kind: "organizationEvents", organizationId: a.organization.id });
  assert.equal(eventResponse.status, 422); assert.equal((await read(eventResponse)).error?.code, "ORGANIZER_INPUT_INVALID");
  const grantResponse = await handler.handle(request("POST", { userId: "staff", role: "admin", eventId: null, expectedOrganizationRevision: a.organization.revision, capabilities: ["event_manage"] }), { kind: "staffGrants", organizationId: a.organization.id });
  assert.equal(grantResponse.status, 422); assert.deepEqual(await c.counts(), before);
});

test("method mismatch returns exact Allow without authentication, mutation hook or reading body", async t => {
  const c = await organizerFixture(t); let calls = 0;
  const handler = createOrganizerHttpHandlers({ service: c.service, authenticate: async () => { calls++; return c.users.ownerA; }, authorizeMutation: async () => { calls++; }, requestId: () => "http-method" });
  for (const [route, method, allow] of [
    [{ kind: "event", eventId: "e" }, "POST", "GET, PATCH"], [{ kind: "competitions" }, "POST", "GET"],
    [{ kind: "publish", eventId: "e" }, "PATCH", "POST"],
  ] as const) {
    const input = request(method, { ignored: true }), response = await handler.handle(input, route);
    assert.equal(response.status, 405); assert.equal(response.headers.get("allow"), allow); assert.equal(input.bodyUsed, false);
    assert.equal((await read(response)).error?.code, "METHOD_NOT_ALLOWED");
  }
  assert.equal(calls, 0); assert.equal(c.guardCalls.size, 0);
});

test("domain conflict preserves status, current revision and recovery text; unknown failures disclose no details", async t => {
  const c = await organizerFixture(t), a = await c.approvedOrganization(), event = await c.createEvent(a.organization.id, a.principal);
  const handler = createOrganizerHttpHandlers({ service: c.service, authenticate: async () => a.principal, authorizeMutation: async () => {}, requestId: () => "http-conflict" });
  const response = await handler.handle(request("PATCH", { ...configurationOf(event), expectedRevision: 88 }), { kind: "event", eventId: event.eventId });
  assert.equal(response.status, 409); const envelope = await read(response);
  assert.equal(envelope.error?.code, "ORGANIZER_REVISION_CONFLICT"); assert.equal(envelope.error?.latestRevision, event.revision);
  assert.ok(envelope.error?.recoveryAction?.includes("重新读取")); assert.equal(envelope.requestId, "http-conflict");
  assert.equal(response.headers.get("vary"), "Cookie"); assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const failing = createOrganizerHttpHandlers({ service: c.service, authenticate: async () => { throw new Error("SENSITIVE_INTERNAL_STACK_OR_CREDENTIAL"); }, authorizeMutation: async () => {}, requestId: () => "http-internal" });
  const unexpected = await failing.handle(request(), { kind: "organizations" });
  assert.equal(unexpected.status, 500); const unknown = await read(unexpected);
  assert.equal(unknown.error?.code, "INTERNAL_ERROR"); assert.equal(JSON.stringify(unknown).includes("SENSITIVE"), false);
});

test("successful mutation records verified applicant identity and private response is never cacheable", async t => {
  const c = await organizerFixture(t); let mutations = 0;
  const handler = createOrganizerHttpHandlers({ service: c.service, authenticate: async () => c.users.ownerA, authorizeMutation: async () => { mutations++; }, requestId: () => "http-success" });
  const response = await handler.handle(request("POST", applicationInput(), { "x-user-id": "administrator" }), { kind: "applications" });
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
  const envelope = await read(response), data = envelope.data as { applicantUserId: string; status: string };
  assert.equal(data.applicantUserId, "ownerA"); assert.equal(data.status, "pending"); assert.equal(mutations, 1);
  assert.equal(c.guardCalls.get("ownerA"), 2);
});
