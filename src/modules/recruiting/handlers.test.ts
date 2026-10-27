import assert from "node:assert/strict";
import test from "node:test";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { FreshSessionGuard } from "../../shared/personal-ai.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import { createRecruitingHttpHandlers, recruitingHttpRoute } from "./handlers.ts";
import type { RecruitingHttpRoute } from "./handlers.ts";
import type { RecruitingService } from "./service.ts";

function fixture() {
  const actor: Actor = { userId: "http-alice", platformRoles: ["user"] }, calls: { name: string; args: unknown[] }[] = [];
  let signedIn = true, csrf = 0, guards = 0;
  const guard: FreshSessionGuard = async () => { guards++; };
  const service = new Proxy({}, { get: (_target, key) => async (...args: unknown[]) => { calls.push({ name: String(key), args }); const last = args.at(-1); if (typeof last === "function") await last({} as SqlExecutor); if (String(key).endsWith("Avatar")) return { bytes: new Uint8Array([1,2,3]), mimeType: "image/png" }; return { saved: true }; } }) as RecruitingService;
  const handlers = createRecruitingHttpHandlers({ service, resolveSession: async () => signedIn ? { actor, guard } : null, authorizeMutation: async () => { csrf++; }, requestId: () => "recruiting-request" });
  return { actor, guard, calls, handlers, setSignedIn(value: boolean) { signedIn = value; }, get csrf() { return csrf; }, get guards() { return guards; } };
}
function request(method = "GET", body?: string, contentType = "application/json", query = "") { return new Request(`https://field.test/api/v1/recruiting${query}`, { method, ...(body === undefined ? {} : { body, headers: { "Content-Type": contentType } }) }); }

test("recruiting router covers every explicit route and rejects inherited/foreign paths", () => {
  const cases: [string, RecruitingHttpRoute][] = [
    ["me/recruiting-profile", { kind: "profile" }], ["me/recruiting-profile/summary", { kind: "summary" }], ["me/recruiting-profile/avatar", { kind: "ownAvatar" }], ["me/recruiting-card/publish", { kind: "publishCard" }], ["me/recruiting-card/withdraw", { kind: "withdrawCard" }], ["recruiting/cards", { kind: "cards" }], ["recruiting/posts", { kind: "posts" }], ["me/recruiting-applications", { kind: "ownApplications" }], ["recruiting/cards/card/avatar", { kind: "publicAvatar", cardId: "card" }], ["projects/space/recruiting-post", { kind: "projectPost", projectId: "space" }], ["projects/space/recruiting-applications", { kind: "projectApplications", projectId: "space" }], ["recruiting/posts/post/applications", { kind: "apply", postId: "post" }], ["recruiting/applications/app/review", { kind: "review", applicationId: "app" }], ["recruiting/applications/app/withdraw", { kind: "withdrawApplication", applicationId: "app" }], ["recruiting/applications/app/join", { kind: "join", applicationId: "app" }],
  ];
  for (const [path, descriptor] of cases) assert.deepEqual(recruitingHttpRoute(path.split("/")), descriptor);
  for (const path of ["__proto__", "constructor", "recruiting/posts/other", "projects/x/recruiting-post/extra", "me/participant-profile"]) assert.equal(recruitingHttpRoute(path.split("/")), null);
});
test("public GET stays signed-out, read-only and bounded to known filters", async () => {
  const f = fixture(); f.setSignedIn(false);
  assert.equal((await f.handlers.handle(request("GET", undefined, undefined, "?role=frontend&purpose=learn&keyword=作品&limit=24"), { kind: "cards" })).status, 200);
  assert.equal(f.calls[0].name, "listCards"); assert.deepEqual(f.calls[0].args[0], { role: "frontend", purpose: "learn", keyword: "作品", limit: 24 });
  assert.equal(f.csrf, 0); assert.equal(f.guards, 0);
  assert.equal((await f.handlers.handle(request("GET", undefined, undefined, "?sql=private"), { kind: "posts" })).status, 400);
  assert.equal((await f.handlers.handle(request(), { kind: "profile" })).status, 401);
});
test("every private mutation checks CSRF and forwards the exact request session guard", async () => {
  const f = fixture(), operations: [RecruitingHttpRoute, string, string][] = [
    [{ kind: "profile" }, "PATCH", "saveProfile"], [{ kind: "summary" }, "POST", "generateSummary"], [{ kind: "ownAvatar" }, "POST", "saveAvatar"], [{ kind: "ownAvatar" }, "DELETE", "removeAvatar"], [{ kind: "publishCard" }, "POST", "publishCard"], [{ kind: "withdrawCard" }, "POST", "withdrawCard"], [{ kind: "projectPost", projectId: "space" }, "POST", "savePost"], [{ kind: "projectPost", projectId: "space" }, "PATCH", "savePost"], [{ kind: "apply", postId: "post" }, "POST", "apply"], [{ kind: "review", applicationId: "app" }, "POST", "reviewApplication"], [{ kind: "withdrawApplication", applicationId: "app" }, "POST", "withdrawApplication"], [{ kind: "join", applicationId: "app" }, "POST", "joinApproved"],
  ];
  for (const [route, method, name] of operations) { const response = await f.handlers.handle(request(method, '{"expectedRevision":1}'), route); assert.equal(response.status, 200); const call = f.calls.at(-1)!; assert.equal(call.name, name); assert.equal(call.args[0], f.actor); assert.equal(call.args.at(-1), f.guard); }
  assert.equal(f.csrf, operations.length); assert.equal(f.guards, operations.length);
});
test("read boundaries forward fresh guards and avatar responses cannot be cached or sniffed", async () => {
  const f = fixture();
  for (const [route, name] of [[{ kind: "profile" }, "getProfile"], [{ kind: "ownApplications" }, "listOwnApplications"], [{ kind: "projectPost", projectId: "space" }, "getPost"], [{ kind: "projectApplications", projectId: "space" }, "listProjectApplications"]] as const) { assert.equal((await f.handlers.handle(request(), route)).status, 200); assert.equal(f.calls.at(-1)!.name, name); assert.equal(f.calls.at(-1)!.args.at(-1), f.guard); }
  const own = await f.handlers.handle(request(), { kind: "ownAvatar" }); assert.equal(own.status, 200); assert.equal(own.headers.get("Content-Type"), "image/png"); assert.equal(own.headers.get("Cache-Control"), "private, no-store"); assert.equal(own.headers.get("X-Content-Type-Options"), "nosniff"); assert.match(own.headers.get("Content-Security-Policy")!, /sandbox/);
  f.setSignedIn(false); const pub = await f.handlers.handle(request("GET", undefined, undefined, "?revision=2"), { kind: "publicAvatar", cardId: "card" }); assert.equal(pub.status, 200); assert.deepEqual(f.calls.at(-1)?.args, ["card", 2]); assert.equal(f.csrf, 0);
});
test("HTTP rejects unsupported methods, invalid content types/JSON and oversized streamed bodies before service calls", async () => {
  const f = fixture();
  const badMethod = await f.handlers.handle(request("POST", "{}"), { kind: "cards" }); assert.equal(badMethod.status, 405); assert.equal(badMethod.headers.get("Allow"), "GET");
  assert.equal((await f.handlers.handle(request("PATCH", "{}", "text/plain"), { kind: "profile" })).status, 415);
  assert.equal((await f.handlers.handle(request("PATCH", "{"), { kind: "profile" })).status, 400);
  assert.equal((await f.handlers.handle(request("PATCH", JSON.stringify({ text: "a".repeat(64 * 1024) })), { kind: "profile" })).status, 413);
  assert.equal((await f.handlers.handle(request("POST", JSON.stringify({ text: "a".repeat(720 * 1024) })), { kind: "ownAvatar" })).status, 413);
  assert.equal(f.calls.length, 0);
});
test("HTTP exposes safe domain recovery information and hides arbitrary provider failures", async () => {
  const service = { getProfile: async () => { throw new DomainError("RECRUITING_CHANGED", "资料变化", { status: 409, latestRevision: 3 }); } } as unknown as RecruitingService;
  const handler = createRecruitingHttpHandlers({ service, resolveSession: async () => ({ actor: { userId: "alice", platformRoles: ["user"] }, guard: async () => {} }), authorizeMutation: async () => {}, requestId: () => "http-id" });
  const response = await handler.handle(request(), { kind: "profile" }); assert.equal(response.status, 409); assert.equal((await response.json()).error.latestRevision, 3);
  service.getProfile = async () => { throw new Error("secret provider token should never appear"); }; const unknown = await handler.handle(request(), { kind: "profile" }); assert.equal(unknown.status, 500); assert.ok(!(await unknown.text()).includes("secret provider token"));
});
