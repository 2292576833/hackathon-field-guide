import test from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../../shared/errors.ts";
import { createEventRegistrationHandlers } from "./http.ts";
import { registrationFixture } from "./test-fixture.ts";
import type { OrganizerPrincipal } from "../../shared/organizer-contracts.ts";

const url = "https://hib.example/api/v1/competitions/event-a/my-registration";
const jsonRequest = (method: string, body: unknown, headers: Record<string, string> = {}) => new Request(url, { method, body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });

test("all factory methods reject wrong verbs before mutation authorization and principal resolution", async () => {
  const f = await registrationFixture(); let resolves = 0, authorizes = 0;
  try {
    const handlers = createEventRegistrationHandlers({ service: f.service, resolvePrincipal: async () => { ++resolves; return f.principals.alice; }, authorizeMutation: async () => { ++authorizes; }, requestIds: { next: () => "request-1" } });
    const methods = { getRegistrationForm: "GET", getStaffForm: "GET", saveForm: "PUT", getMine: "GET", saveDraft: "PATCH", submit: "POST", withdraw: "POST", listStaff: "GET", registrationCounts: "GET", review: "POST", exportRegistrations: "GET", listTeams: "GET", listPublicTeams: "GET", listStaffTeams: "GET", getStaffCandidates: "GET", listTeamSuggestions: "GET", proposeTeam: "POST", createTeam: "POST", requestJoin: "POST", respondJoin: "POST", cancelJoin: "POST", leaveTeam: "POST", lockRoster: "POST", reopenRoster: "POST", requestProjectLink: "POST", getProjectLink: "GET", confirmProjectLink: "POST", listMine: "GET" } as const;
    assert.deepEqual(Object.keys(handlers).sort(), Object.keys(methods).sort());
    for (const name of Object.keys(methods) as (keyof typeof methods)[]) {
      const response = await handlers[name](new Request(url, { method: methods[name] === "GET" ? "DELETE" : "GET" }));
      assert.equal(response.status, 405, name); assert.equal(response.headers.get("Allow"), methods[name]); assert.equal((await response.json()).error.code, "METHOD_NOT_ALLOWED");
    }
    assert.equal(resolves, 0); assert.equal(authorizes, 0); assert.equal(f.statements.length, 0);
  } finally { await f.engine.close(); }
});

test("public GET skips auth and all reads remain read-only; own GET requires trusted guard and no-store headers", async () => {
  const f = await registrationFixture(); let resolves = 0, authorizes = 0; let principal: OrganizerPrincipal | null = null;
  try {
    const handlers = createEventRegistrationHandlers({ service: f.service, resolvePrincipal: async () => { ++resolves; return principal; }, authorizeMutation: async () => { ++authorizes; }, requestIds: { next: () => "request-read" } });
    const publicResponse = await handlers.getRegistrationForm(new Request(url), { eventId: "event-a" });
    assert.equal(publicResponse.status, 200); assert.equal(resolves, 0); assert.equal(authorizes, 0);
    assert.equal((await publicResponse.json()).data.form, null);
    assert.equal((await handlers.getMine(new Request(url), { eventId: "event-a" })).status, 401);
    principal = { actor: f.principals.alice.actor } as OrganizerPrincipal;
    assert.equal((await handlers.getMine(new Request(url), { eventId: "event-a" })).status, 401);
    principal = f.principals.alice;
    const mine = await handlers.getMine(new Request(url), { eventId: "event-a" });
    assert.equal(mine.status, 200); assert.equal(mine.headers.get("Cache-Control"), "private, no-store"); assert.equal(mine.headers.get("Referrer-Policy"), "no-referrer"); assert.equal(mine.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(f.statements.some(sql => /\b(?:INSERT|UPDATE|DELETE)\b/i.test(sql)), false);
    assert.equal((await f.database.query("SELECT * FROM event_registration_event_state")).rowCount, 0);
  } finally { await f.engine.close(); }
});

test("CSRF denial runs before auth or mutation, and missing login cannot enter service", async () => {
  const f = await registrationFixture(); let resolves = 0;
  try {
    const blocked = createEventRegistrationHandlers({ service: f.service, resolvePrincipal: async () => { ++resolves; return f.principals.alice; }, authorizeMutation: async () => { throw new DomainError("CSRF_DENIED", "来源不符。", { status: 403 }); }, requestIds: { next: () => "csrf" } });
    const response = await blocked.submit(jsonRequest("POST", { expectedRevision: 1, idempotencyKey: "key" }), { eventId: "event-a" });
    assert.equal(response.status, 403); assert.equal((await response.json()).error.code, "CSRF_DENIED"); assert.equal(resolves, 0); assert.equal(f.statements.length, 0);
    const loggedOut = createEventRegistrationHandlers({ service: f.service, resolvePrincipal: async () => null, authorizeMutation: async () => {}, requestIds: { next: () => "logged-out" } });
    assert.equal((await loggedOut.saveDraft(jsonRequest("PATCH", { expectedRevision: 0, formRevision: 1, answers: {} }), { eventId: "event-a" })).status, 401);
    assert.equal(f.statements.length, 0);
  } finally { await f.engine.close(); }
});

test("bounded UTF-8 JSON rejects unsupported fields, encodings and invalid bodies before writes", async () => {
  const f = await registrationFixture();
  try {
    const handlers = createEventRegistrationHandlers({ service: f.service, resolvePrincipal: async () => f.principals.alice, authorizeMutation: async () => {}, requestIds: { next: () => "body" }, maxJsonBytes: 80 });
    const cases: [Request, number, string][] = [
      [jsonRequest("PATCH", { expectedRevision: 0, formRevision: 1, answers: {}, userId: "bob" }), 400, "INVALID_INPUT"],
      [new Request(url, { method: "PATCH", body: "{}", headers: { "content-type": "text/plain" } }), 415, "JSON_REQUIRED"],
      [jsonRequest("PATCH", {}, { "content-encoding": "gzip" }), 415, "JSON_REQUIRED"],
      [new Request(url, { method: "PATCH", body: "{", headers: { "content-type": "application/json" } }), 400, "INVALID_JSON"],
      [jsonRequest("PATCH", []), 400, "INVALID_INPUT"],
      [jsonRequest("PATCH", { answers: "汉".repeat(40) }), 413, "PAYLOAD_TOO_LARGE"],
      [new Request(url, { method: "PATCH", body: new Uint8Array([0xff]), headers: { "content-type": "application/json" } }), 400, "INVALID_JSON"],
    ];
    for (const [request, status, code] of cases) { const response = await handlers.saveDraft(request, { eventId: "event-a" }); assert.equal(response.status, status); assert.equal((await response.json()).error.code, code); }
    assert.equal(f.statements.length, 0);
    assert.throws(() => createEventRegistrationHandlers({ service: f.service, resolvePrincipal: async () => null, authorizeMutation: async () => {}, requestIds: { next: () => "" }, maxJsonBytes: 131073 }), /body limit/);
  } finally { await f.engine.close(); }
});

test("header/body idempotency mismatch rejects; trusted principal owns successful draft and header-only submit", async () => {
  const f = await registrationFixture();
  try {
    await f.publish();
    const handlers = createEventRegistrationHandlers({ service: f.service, resolvePrincipal: async () => f.principals.alice, authorizeMutation: async () => {}, requestIds: { next: () => "actual-request" } });
    const mismatch = await handlers.submit(jsonRequest("POST", { expectedRevision: 1, idempotencyKey: "body-key" }, { "Idempotency-Key": "header-key" }), { eventId: "event-a" });
    assert.equal(mismatch.status, 409); assert.equal((await mismatch.json()).error.code, "IDEMPOTENCY_CONFLICT");
    const saved = await handlers.saveDraft(jsonRequest("PATCH", { expectedRevision: 0, formRevision: 1, answers: { goal: "本人参赛" } }), { eventId: "event-a" });
    assert.equal(saved.status, 200); const draft = (await saved.json()).data; assert.equal(draft.userId, "alice");
    const submitted = await handlers.submit(jsonRequest("POST", { expectedRevision: draft.revision }, { "Idempotency-Key": "header-only" }), { eventId: "event-a" });
    assert.equal(submitted.status, 200); assert.equal((await submitted.json()).data.status, "approved");
    await f.database.query("UPDATE auth_users SET session_active=false WHERE id=$1", ["alice"]);
    const replay = await handlers.submit(jsonRequest("POST", { expectedRevision: draft.revision }, { "Idempotency-Key": "header-only" }), { eventId: "event-a" });
    assert.equal(replay.status, 401); assert.equal((await replay.json()).error.code, "UNAUTHENTICATED");
  } finally { await f.engine.close(); }
});

test("public status query cannot republish withdrawn roster and unknown errors disclose no internals", async () => {
  const f = await registrationFixture();
  try {
    await f.publish(); await f.register("alice"); const team = await f.createTeam();
    await f.service.leaveTeam(f.principals.alice, "event-a", team.id, { expectedRevision: 1, idempotencyKey: "withdraw-team" });
    const handlers = createEventRegistrationHandlers({ service: f.service, resolvePrincipal: async () => { throw new Error("private-stack-provider-token"); }, authorizeMutation: async () => {}, requestIds: { next: () => "error-request" } });
    const publicResult = await handlers.listPublicTeams(new Request(`${url}?status=withdrawn`), { eventId: "event-a" });
    assert.equal(publicResult.status, 200); assert.deepEqual((await publicResult.json()).data.teams.items, []);
    const unexpected = await handlers.getMine(new Request(url), { eventId: "event-a" });
    assert.equal(unexpected.status, 500); const body = await unexpected.text(); assert.equal(body.includes("private-stack-provider-token"), false); assert.equal(JSON.parse(body).error.code, "INTERNAL_ERROR");
    const malformed = await handlers.getRegistrationForm(new Request(url), {}); assert.equal(malformed.status, 422); assert.equal((await malformed.json()).error.code, "INVALID_INPUT");
  } finally { await f.engine.close(); }
});
