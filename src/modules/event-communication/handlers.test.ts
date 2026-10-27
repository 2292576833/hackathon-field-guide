import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../shared/errors.ts";
import { createEventCommunicationHttpHandlers, eventCommunicationHttpRoute } from "./handlers.ts";
import type { EventCommunicationHttpDependencies } from "./handlers.ts";

function fixture() {
  const calls: { method: string; args: unknown[] }[] = []; let auth = true, csrf = true;
  const service = new Proxy({}, { get: (_target, method) => async (...args: unknown[]) => { calls.push({ method: String(method), args }); return { saved: true, replies: [] }; } });
  const principal = { actor: { userId: "verified-user", platformRoles: ["user"] }, guard: async () => {} };
  const handler = createEventCommunicationHttpHandlers({ communication: service, schedule: service, logistics: service, requestId: () => "request-id", resolvePrincipal: async () => auth ? principal : null, authorizeMutation: async () => { if (!csrf) throw new DomainError("CSRF_INVALID", "来源不可信", { status: 403 }); } } as unknown as EventCommunicationHttpDependencies);
  const request = (path: string, method = "GET", body?: unknown) => new Request(`https://localhost/api/v1${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  return { calls, principal, handler, request, logout: () => { auth = false; }, failCsrf: () => { csrf = false; } };
}
test("router recognizes only exact event-scoped endpoints and keeps public/staff actions separate", () => {
  assert.deepEqual(eventCommunicationHttpRoute(["competitions", "a", "help-tickets", "id", "replies"]), { kind: "replies", eventId: "a", id: "id" });
  assert.deepEqual(eventCommunicationHttpRoute(["organizer", "events", "b", "help-tickets", "id", "replies"]), { kind: "managedReplies", eventId: "b", id: "id" });
  for (const path of [["competitions", "a", "meal-vouchers", "redeem"], ["organizer", "events", "a", "help-tickets", "id", "publish-consent"], ["competitions", "a", "help-tickets", "id", "faq-preview"], ["organizer", "events", "a", "announcements", "extra", "versions", "oops"]]) assert.equal(eventCommunicationHttpRoute(path), null);
});
test("private requests need session; all responses disable caching even public reads", async () => {
  const f = fixture(); f.logout();
  const privateResponse = await f.handler.handle(f.request("/competitions/a/my-services"), { kind: "ownServices", eventId: "a" });
  assert.equal(privateResponse.status, 401); assert.equal(f.calls.length, 0);
  const publicResponse = await f.handler.handle(f.request("/competitions/a/announcements"), { kind: "announcements", eventId: "a" });
  assert.equal(publicResponse.status, 200); assert.equal(publicResponse.headers.get("cache-control"), "private, no-store"); assert.equal(publicResponse.headers.get("vary"), "Cookie"); assert.equal(f.calls[0].args[0], null);
});
test("unsupported methods and untrusted mutations never reach service", async () => {
  const f = fixture();
  const wrongMethod = await f.handler.handle(f.request("/competitions/a/announcements", "POST", {}), { kind: "announcements", eventId: "a" }); assert.equal(wrongMethod.status, 405); assert.equal(wrongMethod.headers.get("allow"), "GET");
  f.failCsrf(); const response = await f.handler.handle(f.request("/organizer/events/a/announcements", "POST", {}), { kind: "managedAnnouncements", eventId: "a" }); assert.equal(response.status, 403); assert.equal(f.calls.length, 0);
});
test("route event/id and verified principal win over payload targeting", async () => {
  const f = fixture(); const response = await f.handler.handle(f.request("/organizer/events/a/meal-vouchers/right/revoke", "POST", { voucherId: "forged", expectedRevision: 1 }), { kind: "voucherRevoke", eventId: "a", id: "right" });
  assert.equal(response.status, 200); assert.equal(f.calls[0].args[0], f.principal); assert.equal(f.calls[0].args[1], "a"); assert.equal((f.calls[0].args[2] as { voucherId: string }).voucherId, "right");
});
test("malformed and oversized JSON are rejected before mutation", async () => {
  const f = fixture();
  for (const [content, status] of [["[1]", 400], ["{", 400], [JSON.stringify({ csv: "x".repeat(129 * 1024) }), 413]] as const) {
    const response = await f.handler.handle(new Request("https://localhost", { method: "POST", headers: { "content-type": "application/json" }, body: content }), { kind: "scheduleImportPreview", eventId: "a" }); assert.equal(response.status, status);
  }
  assert.equal(f.calls.length, 0);
});
test("staff replies use staff service path, public replies never escalate", async () => {
  const f = fixture();
  await f.handler.handle(f.request("/organizer/events/a/help-tickets/t/replies", "POST", { expectedRevision: 1, body: "答复" }), { kind: "managedReplies", eventId: "a", id: "t" });
  assert.equal(f.calls[0].method, "addReply"); assert.equal(f.calls[0].args[4], true);
  await f.handler.handle(f.request("/competitions/a/help-tickets/t/replies", "POST", { expectedRevision: 1, body: "补充" }), { kind: "replies", eventId: "a", id: "t" });
  assert.equal(f.calls[1].args[4], undefined);
});
