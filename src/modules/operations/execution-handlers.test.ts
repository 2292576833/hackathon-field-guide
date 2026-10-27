import assert from "node:assert/strict";
import test from "node:test";
import type { Actor } from "../../shared/contracts.ts";
import { createExecutionAdminHandlers, createWorkerExecutionHandlers } from "./execution-handlers.ts";
import type { SourceService } from "./source-service.ts";
import type { RunService, WorkerRunService } from "./run-service.ts";

const admin: Actor = { userId: "session-admin", platformRoles: ["admin"] };
const request = (input: unknown) => new Request("https://site.example/api/v1/admin/sources/source-path/crawl-runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
test("source HTTP parses whitelist configuration and rejects missing policy before storage", async () => {
  let actor: Actor | undefined; let created: unknown;
  const sources = { async create(actual: Actor, input: unknown) { actor = actual; created = input; return input; } } as unknown as SourceService;
  const handlers = createExecutionAdminHandlers({ sources, runs: {} as RunService, resolveActor: async () => admin, requestId: () => "request-1", assertMutationAllowed: async () => {} });
  assert.equal((await handlers.createSource(request({ name: "缺少配置" }))).status, 422);
  assert.equal(created, undefined);
  const response = await handlers.createSource(request({ name: "官方规则", ownerUserId: "owner", type: "official_rules", acquisitionMethod: "restricted_http", sampleUrl: "https://events.example.com/rules",
    networkPolicy: { version: 1, rules: [{ hostname: "events.example.com", pathPrefix: "/rules" }], maxRedirects: 2, maxBytes: 50000, timeoutMs: 1000, acceptedContentTypes: ["text/html"] },
    actor: { userId: "forged", platformRoles: ["admin"] }, credentialPolicy: "github-token", token: "do-not-store" }));
  assert.equal(response.status, 201);
  assert.equal(actor?.userId, admin.userId);
  assert.doesNotMatch(JSON.stringify(created), /forged|github-token|do-not-store/);
});
test("crawl HTTP fixes route source, real manual trigger and accepted queued envelope", async () => {
  let actor: Actor | undefined; let captured: Record<string, unknown> = {};
  const runs = { async enqueueCrawl(actual: Actor, input: Record<string, unknown>) { actor = actual; captured = input; return { id: "run-1", status: "queued" }; } } as unknown as RunService;
  const handlers = createExecutionAdminHandlers({ sources: {} as SourceService, runs, resolveActor: async () => admin, requestId: () => "request-1", assertMutationAllowed: async () => {} });
  const response = await handlers.enqueueCrawl("source-path")(request({ sourceConfigId: "forged-source", expectedSourceRevision: 3, targetUrl: "https://events.example.com/rules", adapterVersion: "fixed-v1", idempotencyKey: "key-1", trigger: "scheduled", actor: { userId: "forged" }, requestId: "forged-request" }));
  assert.equal(response.status, 202);
  assert.equal(captured.sourceConfigId, "source-path");
  assert.equal(captured.trigger, "manual");
  assert.equal(captured.requestId, "request-1");
  assert.equal(actor?.userId, admin.userId);
  assert.equal((await response.json()).data.status, "queued");
});
test("worker HTTP has separate service credentials, route-bound run and no publication methods", async () => {
  let calls = 0; let actualCredential = ""; let actualRunId = "";
  const service = { async claim(credential: string, runId: string) { calls++; actualCredential = credential; actualRunId = runId; return { runId, revision: 2, leaseToken: "lease-only", source: { credentialPolicy: "none" } }; } } as unknown as WorkerRunService;
  const unauthorized = createWorkerExecutionHandlers({ service, resolveServiceCredential: async () => null, requestId: () => "req-worker" });
  assert.equal((await unauthorized.claim("run-path")(request({ serviceCredential: "forged", actor: admin }))).status, 401);
  assert.equal(calls, 0);
  const authorized = createWorkerExecutionHandlers({ service, resolveServiceCredential: async () => "verified-bearer", requestId: () => "req-worker" });
  assert.equal(Object.hasOwn(authorized, "publish"), false);
  assert.equal(Object.hasOwn(authorized, "withdraw"), false);
  const response = await authorized.claim("run-path")(request({ runId: "forged-run", serviceCredential: "forged", actor: admin }));
  assert.equal(response.status, 200);
  assert.equal(actualCredential, "verified-bearer");
  assert.equal(actualRunId, "run-path");
  assert.doesNotMatch(await response.text(), /verified-bearer|forged/);
});
