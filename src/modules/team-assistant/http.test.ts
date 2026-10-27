import assert from "node:assert/strict";
import test from "node:test";
import type { Actor } from "../../shared/contracts.ts";
import type { FreshSessionGuard } from "../../shared/personal-ai.ts";
import { DomainError } from "../../shared/errors.ts";
import { createTeamAssistantHandlers } from "./http.ts";
import type { TeamAssistantService } from "./service.ts";

function setup() {
  let calls = 0, mutationChecks = 0, guardPassed = false, actorId = "", requestSerial = 0;
  const service = {
    async conversation(actor: Actor, projectId: string, guard: FreshSessionGuard) { calls++; actorId = actor.userId; guardPassed = typeof guard === "function"; return { projectId }; },
    async send(actor: Actor, projectId: string, input: unknown, guard: FreshSessionGuard) { calls++; actorId = actor.userId; guardPassed = typeof guard === "function"; return { projectId, input }; },
    async clearConversation(_actor: Actor, _projectId: string, revision: number) { calls++; return { cleared: true, revision }; },
    async getContext() { calls++; throw new Error("secret provider stack"); },
  } as unknown as TeamAssistantService;
  const handlers = createTeamAssistantHandlers({ service,
    resolveActor: async req => req.headers.get("x-session") === "valid" ? { userId: "session-user", platformRoles: ["user"] } : null,
    authorizeMutation: async req => { mutationChecks++; if (req.headers.get("origin") !== "https://site.test") throw new DomainError("ORIGIN_DENIED", "请求来源无效。", { status: 403 }); },
    freshSessionGuard: () => async () => {}, requestIds: { next: () => `request-${++requestSerial}` },
  });
  return { handlers, state: () => ({ calls, mutationChecks, guardPassed, actorId }) };
}
function post(body: unknown, headers: Record<string, string> = {}) { return new Request("https://site.test/api/projects/one/assistant/messages", { method: "POST", headers: { "content-type": "application/json", "x-session": "valid", origin: "https://site.test", ...headers }, body: JSON.stringify(body) }); }
test("private handlers require authenticated actor and method, never take body identity", async () => {
  const f = setup(); assert.equal((await f.handlers.conversation(new Request("https://site.test"), { projectId: "one" })).status, 401);
  assert.equal((await f.handlers.conversation(post({}), { projectId: "one" })).status, 405);
  const response = await f.handlers.send(post({ userId: "victim", message: "问本人任务", requestId: "ask", expectedRevision: 0 }), { projectId: "one" });
  assert.equal(response.status, 200); assert.equal(f.state().actorId, "session-user"); assert.equal(f.state().guardPassed, true); assert.equal(f.state().mutationChecks, 1);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});
test("mutations reject untrusted origin and oversized, compressed or malformed JSON", async () => {
  const f = setup();
  assert.equal((await f.handlers.send(post({}, { origin: "https://other.test" }), { projectId: "one" })).status, 403);
  assert.equal((await f.handlers.send(post({ message: "x".repeat(28001) }), { projectId: "one" })).status, 413);
  assert.equal((await f.handlers.send(post({}, { "content-encoding": "gzip" }), { projectId: "one" })).status, 415);
  assert.equal((await f.handlers.send(post([], {}), { projectId: "one" })).status, 422);
  const malformed = new Request("https://site.test", { method: "POST", headers: { "x-session": "valid", origin: "https://site.test", "content-type": "application/json" }, body: "{" });
  assert.equal((await f.handlers.send(malformed, { projectId: "one" })).status, 400); assert.equal(f.state().calls, 0);
});
test("GET reads never authorize model calls and unknown errors do not reveal details", async () => {
  const f = setup(); const req = new Request("https://site.test", { headers: { "x-session": "valid" } });
  assert.equal((await f.handlers.conversation(req, { projectId: "one" })).status, 200);
  const response = await f.handlers.context(req, { projectId: "one" }); assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /secret provider stack/); assert.equal(f.state().mutationChecks, 0);
});
