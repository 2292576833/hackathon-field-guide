import test from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../../shared/errors.ts";
import { availabilityFromProjectCollection, createMemberAvailabilityValidator } from "./availability.ts";
import { membership } from "./testing/fixtures.ts";

test("M02 adapter calculates union capacity and leaves sole collection ownership in M02", async () => {
  const adapter = createMemberAvailabilityValidator({ getMembership: async () => membership("member", "pm2") });
  const result = await adapter.validate({ projectId: "p1", userId: "member", timezone: "Asia/Shanghai", nextRevision: 2, previous: null, windows: [
    { id: "a", startsAt: "2026-10-08T09:00:00+08:00", endsAt: "2026-10-08T11:00:00+08:00", effectiveMinutes: 120 },
    { id: "b", startsAt: "2026-10-08T10:00:00+08:00", endsAt: "2026-10-08T12:00:00+08:00", effectiveMinutes: 120 },
  ] });
  assert.equal(result.effectiveMinutes, 180);
  assert.deepEqual(result.windows.map(window => window.revision), [2, 2]);
});
test("reported partial hours cannot turn an unspecified four-hour span into schedulable work", async () => {
  const adapter = createMemberAvailabilityValidator({ getMembership: async () => membership("member", "pm2") });
  await assert.rejects(adapter.validate({ projectId: "p1", userId: "member", timezone: "Asia/Shanghai", nextRevision: 1, previous: null, windows: [{ id: "a", startsAt: "2026-10-08T09:00:00+08:00", endsAt: "2026-10-08T13:00:00+08:00", effectiveMinutes: 120 }] }), (error: unknown) => error instanceof DomainError && error.code === "AVAILABILITY_NEEDS_EXACT_WINDOWS");
});
test("membership change invalidates old availability and mapping never adds derived capacity", () => {
  const collection = { projectId: "p1", userId: "member", timezone: "Asia/Shanghai", confirmedAt: "2026-10-08T01:00:00Z", revision: 1, membershipRevision: 1,
    windows: [{ id: "a", startsAt: "2026-10-08T01:00:00Z", endsAt: "2026-10-08T03:00:00Z", effectiveMinutes: 120, revision: 1 }] };
  const current = availabilityFromProjectCollection(collection, { ...membership("member", "pm2"), revision: 1 });
  assert.equal(current.windows.length, 1); assert.equal(current.version, 1); assert.equal("effectiveMinutes" in current, false);
  const stale = availabilityFromProjectCollection(collection, { ...membership("member", "pm2"), revision: 2 });
  assert.equal(stale.confirmedAt, null); assert.deepEqual(stale.windows, []);
});
