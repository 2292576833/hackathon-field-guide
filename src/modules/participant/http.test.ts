import assert from "node:assert/strict";
import test from "node:test";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { ParticipantProfile } from "../../shared/participant.ts";
import type { FreshSessionGuard } from "../../shared/personal-ai.ts";
import { createParticipantHandlers } from "./http.ts";
import type { ParticipantService, ParticipantProfileUpdate } from "./service.ts";

const origin = "https://guide.example.test";
const actor: Actor = { userId: "private-user", platformRoles: ["user"] };
const profile: ParticipantProfile = {
  userId: actor.userId, revision: 0, firstHackathon: null, developmentExperience: null, city: "", skills: [],
  interests: [], projectIdea: "", availableHoursPerDay: null, travelPreference: "undecided", presentationExperience: null, updatedAt: null,
};
const update: ParticipantProfileUpdate = {
  expectedRevision: 0, firstHackathon: true, developmentExperience: "none", city: "上海", skills: [], interests: ["公益"],
  projectIdea: "", availableHoursPerDay: 1, travelPreference: "local", presentationExperience: "none",
};
function fixture() {
  let loggedIn = true; let calls = 0; let error: Error | null = null;
  const guard: FreshSessionGuard = async () => {};
  const service: ParticipantService = {
    async get(received, receivedGuard) {
      calls += 1; assert.equal(received, actor); assert.equal(receivedGuard, guard);
      if (error) throw error; return profile;
    },
    async update(received, value, receivedGuard) {
      calls += 1; assert.equal(received, actor); assert.equal(receivedGuard, guard);
      if (error) throw error;
      const { expectedRevision, ...editable } = value;
      return { ...profile, ...editable, revision: expectedRevision + 1, updatedAt: "2026-10-09T08:00:00.000Z" };
    },
  };
  const options = {
    service, origin, requestIds: { next: () => "participant-request" },
    resolvePrincipal: async () => loggedIn ? { actor, guard } : null,
  };
  return {
    handlers: createParticipantHandlers(options), options,
    setLoggedIn(value: boolean) { loggedIn = value; }, setError(value: Error) { error = value; }, get calls() { return calls; },
  };
}
function request(method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/v1/me/participant-profile`, {
    method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(method === "PATCH" ? { origin } : {}), ...headers },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
}

test("participant HTTP exposes direct private profile envelopes and passes a transaction session guard", async () => {
  const f = fixture();
  const read = await f.handlers.getProfile(request());
  assert.equal(read.status, 200); assert.deepEqual(await read.json(), { data: profile, requestId: "participant-request" });
  assert.equal(read.headers.get("cache-control"), "private, no-store"); assert.equal(read.headers.get("x-content-type-options"), "nosniff");
  const write = await f.handlers.patchProfile(request("PATCH", update));
  assert.equal(write.status, 200);
  const saved = (await write.json()).data as ParticipantProfile;
  assert.equal(saved.userId, actor.userId); assert.equal(saved.revision, 1); assert.equal(saved.city, "上海");
  assert.equal(f.calls, 2);
});

test("authentication, origin and allowed methods reject requests before profile calls", async () => {
  const f = fixture(); f.setLoggedIn(false);
  assert.equal((await f.handlers.handle(request())).status, 401);
  assert.equal((await f.handlers.handle(request("PATCH", update))).status, 401);
  f.setLoggedIn(true);
  assert.equal((await f.handlers.handle(request("PATCH", update, { origin: "https://evil.example.test" }))).status, 403);
  const missing = request("PATCH", update); missing.headers.delete("origin");
  assert.equal((await f.handlers.handle(missing)).status, 403);
  const wrongMethod = await f.handlers.handle(request("POST", update));
  assert.equal(wrongMethod.status, 405); assert.equal(wrongMethod.headers.get("allow"), "GET, PATCH");
  const boundMethod = await f.handlers.getProfile(request("PATCH", update));
  assert.equal(boundMethod.status, 405); assert.equal(boundMethod.headers.get("allow"), "GET");
  assert.equal(f.calls, 0);
});

test("invalid body ownership, compressed data, malformed JSON and byte limits never reach service", async () => {
  const f = fixture();
  for (const value of [{ ...update, userId: "another-account" }, { ...update, revision: 8 }, [], null, {}]) {
    assert.equal((await f.handlers.patchProfile(request("PATCH", value))).status, 422);
  }
  assert.equal((await f.handlers.patchProfile(request("PATCH", "{invalid"))).status, 400);
  assert.equal((await f.handlers.patchProfile(request("PATCH", update, { "content-type": "text/plain" }))).status, 415);
  assert.equal((await f.handlers.patchProfile(request("PATCH", update, { "content-encoding": "gzip" }))).status, 415);
  const small = createParticipantHandlers({ ...f.options, maxJsonBytes: 64 });
  assert.equal((await small.patchProfile(request("PATCH", update))).status, 413);
  assert.equal((await small.patchProfile(request("PATCH", {}, { "content-length": "65" }))).status, 413);
  assert.equal(f.calls, 0);
});

test("revision conflicts and cross-bundle domain errors retain stable status without exposing provider details", async () => {
  const f = fixture();
  f.setError(new DomainError("PARTICIPANT_PROFILE_CHANGED", "画像已有更新。", { status: 409, latestRevision: 3, recoveryAction: "reload_profile" }));
  const conflict = await f.handlers.patchProfile(request("PATCH", update));
  assert.equal(conflict.status, 409); assert.equal((await conflict.json()).error.latestRevision, 3);
  const copiedError = Object.assign(new Error("请重新登录。"), { name: "DomainError", code: "UNAUTHENTICATED", status: 401 });
  f.setError(copiedError);
  assert.equal((await f.handlers.getProfile(request())).status, 401);
  f.setError(new Error("sensitive provider response"));
  const unexpected = await f.handlers.getProfile(request());
  assert.equal(unexpected.status, 500); assert.equal((await unexpected.json()).error.code, "INTERNAL_ERROR");
  assert.doesNotMatch(await (await f.handlers.getProfile(request())).text(), /sensitive provider/);
});

test("HTTP factory validates configuration and requires fresh-session integration", async () => {
  const f = fixture();
  for (const badOrigin of ["relative", `${origin}/`, `${origin}/api`, "ftp://guide.example.test"]) {
    assert.throws(() => createParticipantHandlers({ ...f.options, origin: badOrigin }));
  }
  for (const maxJsonBytes of [0, 65_537, 1.1]) assert.throws(() => createParticipantHandlers({ ...f.options, maxJsonBytes }));
  const missingGuard = createParticipantHandlers({ ...f.options, resolvePrincipal: async () => ({ actor, guard: undefined as unknown as FreshSessionGuard }) });
  assert.equal((await missingGuard.getProfile(request())).status, 500); assert.equal(f.calls, 0);
});
