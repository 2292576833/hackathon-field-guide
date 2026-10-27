import assert from "node:assert/strict";
import test from "node:test";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { createOperationsHttpHandler, positiveRevision } from "./http.ts";

const actor: Actor = { userId: "trusted-session-user", platformRoles: ["reviewer"] };
function request(body: string, method = "POST") { return new Request("https://site.example/api/v1/admin/events/review", { method, body: method === "GET" ? undefined : body, headers: { "Content-Type": "application/json" } }); }
function setup(options: { actor?: Actor | null; maxBytes?: number; rejectMutation?: boolean } = {}) {
  let observed: Actor | undefined;
  let calls = 0;
  const handler = createOperationsHttpHandler({
    resolveActor: async () => options.actor === undefined ? actor : options.actor,
    requestId: () => "request-safe", maxBodyBytes: options.maxBytes,
    assertMutationAllowed: async () => { if (options.rejectMutation) throw new DomainError("CSRF_REJECTED", "请求来源无效。", { status: 403 }); },
  }, { method: "POST", execute: async (actual, input) => { observed = actual; calls++; if (input.throw) throw new Error("secret provider token"); return { actorId: actual.userId, revision: positiveRevision(input, "expectedRevision") }; } });
  return { handler, get observed() { return observed; }, get calls() { return calls; } };
}
test("HTTP action resolves trusted identity and ignores forged request role/userId", async () => {
  const f = setup(); const result = await f.handler(request(JSON.stringify({ expectedRevision: 1, userId: "attacker", platformRoles: ["admin"] })));
  assert.equal(result.status, 200);
  assert.equal(f.observed?.userId, actor.userId);
  assert.deepEqual(await result.json(), { data: { actorId: actor.userId, revision: 1 }, requestId: "request-safe" });
  assert.equal(result.headers.get("cache-control"), "no-store");
});
test("unauthenticated and CSRF-blocked requests never invoke service", async () => {
  for (const options of [{ actor: null }, { rejectMutation: true }]) {
    const f = setup(options); const result = await f.handler(request('{"expectedRevision":1}'));
    assert.equal(result.status, options.actor === null ? 401 : 403);
    assert.equal(f.calls, 0);
  }
});
test("malformed, oversized and invalid revisions are rejected without internal error disclosure", async () => {
  const cases = [{ value: "broken", status: 422 }, { value: '{"expectedRevision":1,"content":"too large"}', status: 413, maxBytes: 10 }, { value: '{"expectedRevision":"1"}', status: 422 }];
  for (const item of cases) {
    const f = setup({ maxBytes: item.maxBytes }); const result = await f.handler(request(item.value));
    assert.equal(result.status, item.status);
    assert.equal((await result.json()).requestId, "request-safe");
  }
  const f = setup(); const result = await f.handler(request('{"throw":true}'));
  assert.equal(result.status, 500);
  assert.doesNotMatch(await result.text(), /secret|token|stack/);
});
test("unsupported HTTP method and array JSON are rejected", async () => {
  const f = setup();
  assert.equal((await f.handler(request("", "GET"))).status, 405);
  assert.equal((await f.handler(request("[]"))).status, 422);
  assert.equal(f.calls, 0);
});
