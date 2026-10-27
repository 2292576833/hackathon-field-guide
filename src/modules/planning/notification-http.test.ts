import assert from "node:assert/strict";
import test from "node:test";
import type { Actor } from "../../shared/contracts.ts";
import { createPlanningNotificationHandlers } from "./notification-http.ts";
import type { OwnPlanningNotification } from "./notification-types.ts";

const actor: Actor = { userId: "verified-user", platformRoles: ["user"] };
function context(authenticated = true) {
  const calls: unknown[] = [];
  const handlers = createPlanningNotificationHandlers({ requestIds: { next: () => "request-1" }, resolveActor: async () => authenticated ? actor : null, authorizeMutation: async () => { calls.push("csrf"); }, service: {
    async listOwn(verified, options) { calls.push({ method: "list", verified, options }); return []; },
    async markRead(verified, id, command) { calls.push({ method: "read", verified, id, command }); return {} as OwnPlanningNotification; },
    async dismissResolved(verified, id, command) { calls.push({ method: "dismiss", verified, id, command }); return {} as OwnPlanningNotification; },
  } });
  return { handlers, calls };
}
test("GET reminders is a no-store read with verified actor and no mutation/dispatch", async () => {
  const c = context(); const result = await c.handlers.listOwn(new Request("https://local.test/api/v1/me/planning-notifications?limit=12"));
  assert.equal(result.status, 200); assert.equal(result.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(c.calls, [{ method: "list", verified: actor, options: { limit: 12 } }]);
});
test("notification mutations reject forged identities, enforce CSRF, and pass only CAS revision", async () => {
  const c = context();
  const request = (body: unknown) => new Request("https://local.test/api/v1/me/planning-notifications/n1/read", { method: "POST", body: JSON.stringify(body) });
  assert.equal((await c.handlers.markRead(request({ expectedRevision: 1, userId: "other" }), "n1")).status, 422);
  assert.deepEqual(c.calls, ["csrf"]);
  assert.equal((await c.handlers.markRead(request({ expectedRevision: 2 }), "n1")).status, 200);
  assert.deepEqual(c.calls.at(-1), { method: "read", verified: actor, id: "n1", command: { expectedRevision: 2 } });
  assert.equal((await c.handlers.markRead(request({ expectedRevision: 0 }), "n1")).status, 422);
});
test("anonymous and wrong-method reads cannot touch reminders", async () => {
  const c = context(false); assert.equal((await c.handlers.listOwn(new Request("https://local.test/me/planning-notifications"))).status, 401); assert.deepEqual(c.calls, []);
  const d = context(); assert.equal((await d.handlers.listOwn(new Request("https://local.test/me/planning-notifications", { method: "POST" }))).status, 405); assert.deepEqual(d.calls, []);
});
