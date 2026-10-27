import assert from "node:assert/strict";
import test from "node:test";
import { createAccountCompletionHandlers, type AccountCompletionHttpService } from "./account-http.ts";

function fixture() {
  const seen: unknown[] = [];
  const service = {
    getDataOverview: async (token: unknown) => { seen.push(token); return { exports: [], deletionRequest: null, impact: { lastManagerProjects: [], notices: [] } }; },
    requestExport: async (token: unknown) => { seen.push(token); return { id: "export-one", status: "queued" }; },
    prepareExport: async (...args: unknown[]) => { seen.push(args); return { id: "export-one", status: "ready" }; },
    downloadExport: async (...args: unknown[]) => { seen.push(args); return { filename: "hackathon-own-data-2026-10-10.json", json: '{"userId":"owner"}' }; },
    requestDeletion: async (token: unknown) => { seen.push(token); return { id: "deletion-one", status: "pending" }; },
    refreshDeletion: async (...args: unknown[]) => { seen.push(args); return { id: "deletion-one", status: "blocked" }; },
    cancelDeletion: async (...args: unknown[]) => { seen.push(args); return { id: "deletion-one", status: "cancelled" }; },
    requestEmailChange: async (...args: unknown[]) => { seen.push(args); return { challengeId: "challenge-one", expiresAt: "2026-10-10T00:10:00Z", resendAfterSeconds: 60, message: "受理" }; },
    verifyEmailChange: async (...args: unknown[]) => { seen.push(args); return { changed: true, requiresLogin: true, profile: { id: "owner", email: "new@example.test" } }; },
  } as unknown as AccountCompletionHttpService;
  const handlers = createAccountCompletionHandlers({ service, origin: "https://site.example.test", requestIds: { next: () => "request-id" },
    clientKeys: { getClientKey: async () => "trusted-client" }, readSessionToken: () => "cookie-only",
    clearSessionCookie: "__Host-hackathon_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure" });
  const request = (body: unknown, method = "POST", origin = "https://site.example.test") => new Request("https://site.example.test/api", {
    method, headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { handlers, seen, request, service };
}

test("account HTTP rejects owner fields and forged origins before service calls", async () => {
  const { handlers, seen, request } = fixture();
  assert.equal((await handlers.requestExport(request({ userId: "other" }))).status, 422);
  assert.equal((await handlers.requestExport(request({}, "POST", "https://evil.example.test"))).status, 403);
  assert.equal((await handlers.requestDeletion(request({ confirmed: false }))).status, 422);
  assert.deepEqual(seen, []);
  const response = await handlers.requestExport(request({}));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(seen, ["cookie-only"]);
});

test("account download returns an authenticated attachment and only accepts one request ID", async () => {
  const { handlers, seen } = fixture();
  const denied = await handlers.downloadExport(new Request("https://site.example.test/api?id=x&id=y"));
  assert.equal(denied.status, 422); assert.deepEqual(seen, []);
  const response = await handlers.downloadExport(new Request("https://site.example.test/api?id=export-one"));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-disposition")!, /attachment; filename="hackathon-own-data-2026-10-10.json"/);
  assert.deepEqual(seen, [["cookie-only", "export-one"]]); assert.equal(await response.text(), '{"userId":"owner"}');
});

test("successful email verification clears the existing auth cookie and projects a login-required result", async () => {
  const { handlers, seen, request } = fixture();
  const response = await handlers.verifyEmailChange(request({ challengeId: "challenge-one", currentCode: "01234567", newCode: "76543210" }));
  assert.equal(response.status, 200); assert.match(response.headers.get("set-cookie")!, /Max-Age=0/);
  assert.deepEqual(seen, [["cookie-only", { challengeId: "challenge-one", currentCode: "01234567", newCode: "76543210" }, "trusted-client"]]);
  const body = await response.json();
  assert.equal(body.data.requiresLogin, true); assert.ok(!JSON.stringify(body).includes("01234567"));
});

test("account HTTP sanitizes provider failures and rejects oversized byte bodies", async () => {
  const { handlers, request, service } = fixture();
  service.requestExport = async () => { throw new Error("secret-provider-token"); };
  const failure = await handlers.requestExport(request({}));
  assert.equal(failure.status, 500); assert.ok(!(await failure.text()).includes("secret-provider-token"));
  const tooLarge = await handlers.requestEmailChange(request({ newEmail: "中".repeat(3000), expectedRevision: 1 }));
  assert.equal(tooLarge.status, 413);
  assert.equal((await handlers.getDataOverview(new Request("https://site.example.test/api", { method: "POST" }))).status, 405);
});
