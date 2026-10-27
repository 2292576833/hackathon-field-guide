import test from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../../shared/contracts.ts";
import { createCorrectionHandlers } from "./correction-handlers.ts";
import { CorrectionService } from "./correction-service.ts";

const actor: Actor = { userId: "owner-from-session", platformRoles: ["user"] };
test("correction submit maps only public-reference fields and retains verified owner", async () => {
  const service = new CorrectionService({ repository: { transaction: async () => { throw new Error("unused"); }, listOwn: async () => [], listQueue: async () => [] }, targets: { isPublicVersion: async () => false }, clock: { now: () => new Date() }, ids: { next: () => "unused" } });
  let captured: unknown;
  service.submit = async (receivedActor, input) => { captured = { actor: receivedActor, input }; return {} as never; };
  const handlers = createCorrectionHandlers({ service, resolveActor: async () => actor, requestId: () => "req", assertMutationAllowed: async () => {} });
  const request = new Request("https://local.example/api/v1/corrections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ submittedBy: "another-owner", actor: { userId: "spoofed" }, target: { kind: "resource", entityId: "r1", version: 1, privateProjectId: "private" }, field: "费用", message: "变更", evidenceUrls: [] }) });
  const response = await handlers.submit(request);
  assert.equal(response.status, 201);
  assert.deepEqual(captured, { actor, input: { target: { kind: "resource", entityId: "r1", version: 1 }, field: "费用", message: "变更", evidenceUrls: [] } });
});
