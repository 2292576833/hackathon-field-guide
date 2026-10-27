import test from "node:test";
import assert from "node:assert/strict";
import { createTeamCollaborationHandlers } from "./http.ts";
import type { PublishSuggestionCommand } from "./types.ts";
import { DomainError } from "../../shared/errors.ts";

function setup(options: { unauthenticated?: boolean; csrf?: boolean } = {}) {
  let mutationChecks = 0; const writes: PublishSuggestionCommand[] = [];
  const handlers = createTeamCollaborationHandlers({ requestIds: { next: () => "request-id" },
    async resolveActor() { return options.unauthenticated ? null : { userId: "real-session-user", platformRoles: [] }; },
    async authorizeMutation() { mutationChecks++; if (options.csrf) throw new DomainError("CSRF_REJECTED", "来源校验失败。", { status: 403 }); },
    service: {
      async listFeed(actor, projectId) { assert.equal(actor.userId, "real-session-user"); return { projectId, membershipId: "membership-1", role: "member", readOnly: false, checkedAt: "2026-10-09T00:00:00Z", items: [] }; },
      async publish(actor, _project, command) { assert.equal(actor.userId, "real-session-user"); writes.push(command); return { id: "s1", revision: 1, status: "discussion", replayed: false }; },
      async edit() { return { id: "s1", revision: 2, status: "discussion", replayed: false }; },
      async withdraw() { return { id: "s1", revision: 2, status: "withdrawn", replayed: false }; },
      async adopt() { return { id: "s1", revision: 2, status: "adopted", replayed: false }; },
    } });
  return { handlers, writes, checks: () => mutationChecks };
}
const command = { sourceKind: "navigator", sourceId: "answer1", title: "验证想法", body: "明确共享的片段", idempotencyKey: "key-1" };
function request(body: unknown = command, headers: Record<string, string> = {}) { return new Request("http://localhost/api/v1/projects/p1/team-feed", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }); }

test("HTTP uses trusted session actor, no-store and CSRF then preserves idempotency key", async () => {
  const { handlers, writes, checks } = setup();
  const response = await handlers.publish(request(command, { "Idempotency-Key": "key-1" }), { projectId: "p1" });
  assert.equal(response.status, 201); assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.equal(checks(), 1); assert.equal(writes[0]?.idempotencyKey, "key-1");
  const anonymous = setup({ unauthenticated: true });
  assert.equal((await anonymous.handlers.publish(request(), { projectId: "p1" })).status, 401); assert.equal(anonymous.checks(), 0);
  const csrf = setup({ csrf: true }); assert.equal((await csrf.handlers.publish(request(), { projectId: "p1" })).status, 403); assert.equal(csrf.writes.length, 0);
});
test("HTTP rejects spoofed authors, mismatched keys, malformed JSON and streamed oversized body before service", async () => {
  const { handlers, writes } = setup();
  assert.equal((await handlers.publish(request({ ...command, authorUserId: "someone-else" }), { projectId: "p1" })).status, 400);
  assert.equal((await handlers.publish(request(command, { "Idempotency-Key": "other" }), { projectId: "p1" })).status, 409);
  assert.equal((await handlers.publish(request({ ...command, body: "x".repeat(40000) }), { projectId: "p1" })).status, 413);
  const invalid = new Request("http://localhost", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{broken" });
  assert.equal((await handlers.publish(invalid, { projectId: "p1" })).status, 400); assert.equal(writes.length, 0);
});
