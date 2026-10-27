import test from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../../shared/errors.ts";
import type { Actor } from "../../shared/contracts.ts";
import { AGENT_IDS } from "../skills/index.ts";
import { createSkillReviewHandlers } from "./skill-review-handlers.ts";
import type { SkillReviewService } from "./skill-review-service.ts";

const actor: Actor = { userId: "current-reviewer", platformRoles: ["reviewer"] };
const target = { kind: "skill" as const, id: "skill", versionId: `skill@${"a".repeat(40)}` };
const expected = { expectedCandidateRevision: 3, expectedContentHash: "b".repeat(64), expectedManifestHash: "c".repeat(64) };
function request(input: unknown, method = "POST", contentType = "application/json"): Request {
  return new Request("https://site.example/api/admin/skills", { method, headers: { "Content-Type": contentType }, ...(method === "GET" ? {} : { body: JSON.stringify(input) }) });
}
function fixture(options: { actor?: Actor | null; mutationError?: Error; maxBodyBytes?: number } = {}) {
  const calls: { method: string; arguments: unknown[] }[] = []; let mutationChecks = 0;
  const service = Object.fromEntries(["register", "decide", "publish", "withdraw", "getDetail", "list"].map(method => [method, async (...args: unknown[]) => { calls.push({ method, arguments: args }); return { safe: true }; }])) as unknown as SkillReviewService;
  const handlers = createSkillReviewHandlers({ service, resolveActor: async () => options.actor === undefined ? actor : options.actor, requestId: () => "request-skill-review", assertMutationAllowed: async () => { mutationChecks++; if (options.mutationError) throw options.mutationError; }, maxBodyBytes: options.maxBodyBytes });
  return { handlers, calls, mutations: () => mutationChecks };
}

test("skill review handlers use authenticated actor and mandatory mutation hook, then exact revision/hash DTO", async () => {
  const f = fixture();
  const response = await f.handlers.register(target)(request(expected));
  assert.equal(response.status, 201); assert.equal(response.headers.get("cache-control"), "no-store"); assert.equal(f.mutations(), 1);
  assert.deepEqual(f.calls[0]?.arguments, [actor, target, expected, "request-skill-review"]);
  const approved = { ...expected, expectedRevision: 2, decision: "approved", reason: "固定版本核验", verification: { licenseChecked: true, behaviorChecked: true, acknowledgedCompatibility: [...AGENT_IDS] } };
  assert.equal((await f.handlers.decide("review-id")(request(approved))).status, 200);
  assert.deepEqual(f.calls[1]?.arguments, [actor, "review-id", approved, "request-skill-review"]);
  assert.equal((await f.handlers.publish("review-id")(request({ ...expected, expectedRevision: 3 }))).status, 200);
  assert.equal((await f.handlers.withdraw(target)(request({ ...expected, operationId: "withdraw-id", reason: "安全撤回" }))).status, 200);
  assert.equal(f.mutations(), 4);
});

test("unauthenticated or blocked mutation cannot invoke service; error response preserves request ID and hides internal details", async () => {
  const loggedOut = fixture({ actor: null }); const response = await loggedOut.handlers.register(target)(request(expected));
  assert.equal(response.status, 401); assert.equal(loggedOut.calls.length, 0); assert.equal(loggedOut.mutations(), 0);
  assert.deepEqual(await response.json(), { error: { code: "UNAUTHENTICATED", message: "请先登录。" }, requestId: "request-skill-review" });
  const csrf = fixture({ mutationError: new DomainError("CSRF_INVALID", "请刷新页面。", { status: 403 }) });
  assert.equal((await csrf.handlers.publish("review")(request({ ...expected, expectedRevision: 1 }))).status, 403); assert.equal(csrf.calls.length, 0);
  const internal = fixture({ mutationError: new Error("secret fixture stack") }); const failed = await internal.handlers.register(target)(request(expected));
  assert.equal(failed.status, 500); assert.doesNotMatch(await failed.text(), /secret fixture stack/);
});

test("unknown fields, forged actor, invalid compatibility, nonapproval verification and malformed revisions are rejected", async () => {
  const f = fixture();
  const cases = [
    f.handlers.register(target)(request({ ...expected, userId: "forged", platformRoles: ["admin"] })),
    f.handlers.publish("review")(request({ ...expected, expectedRevision: 1, operationId: "unsupported" })),
    f.handlers.decide("review")(request({ ...expected, expectedRevision: 1, decision: "approved", reason: "test", verification: { licenseChecked: true, behaviorChecked: true, acknowledgedCompatibility: ["fake-tool"] } })),
    f.handlers.decide("review")(request({ ...expected, expectedRevision: 1, decision: "approved", reason: "test", verification: { licenseChecked: true, behaviorChecked: true, acknowledgedCompatibility: ["codex", "codex"] } })),
    f.handlers.decide("review")(request({ ...expected, expectedRevision: 1, decision: "approved", reason: "test", verification: { licenseChecked: true, behaviorChecked: true, acknowledgedCompatibility: [], allSupported: true } })),
    f.handlers.decide("review")(request({ ...expected, expectedRevision: 1, decision: "rejected", reason: "test", verification: { licenseChecked: true, behaviorChecked: true, acknowledgedCompatibility: [] } })),
    f.handlers.register(target)(request({ ...expected, expectedCandidateRevision: 0 })),
    f.handlers.register(target)(request({ ...expected, expectedCandidateRevision: "3" })),
  ];
  for (const response of await Promise.all(cases)) assert.equal(response.status, 422);
  assert.equal(f.calls.length, 0);
});

test("body size is measured in bytes, methods and content type are enforced", async () => {
  const f = fixture({ maxBodyBytes: 16 });
  assert.equal((await f.handlers.register(target)(request({ note: "中文中文中文中文" }))).status, 413);
  assert.equal((await f.handlers.register(target)(request(expected, "POST", "text/plain"))).status, 415);
  assert.equal((await f.handlers.register(target)(request({}, "GET"))).status, 405);
  const bad = new Request("https://site.example/api/admin/skills", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  assert.equal((await f.handlers.register(target)(bad)).status, 422); assert.equal(f.calls.length, 0);
});

test("list/detail are read only and list refuses duplicate or unsupported query fields", async () => {
  const f = fixture();
  assert.equal((await f.handlers.list(new Request("https://site.example/reviews?status=pending&limit=20"))).status, 200);
  assert.deepEqual(f.calls[0]?.arguments, [actor, "pending", 20, "request-skill-review"]);
  assert.equal((await f.handlers.detail("review-id")(new Request("https://site.example/reviews/review-id"))).status, 200);
  assert.equal(f.mutations(), 0);
  assert.equal((await f.handlers.list(new Request("https://site.example/reviews?status=pending&status=approved"))).status, 422);
  assert.equal((await f.handlers.list(new Request("https://site.example/reviews?userId=other"))).status, 422);
  assert.equal(f.calls.length, 2);
});
