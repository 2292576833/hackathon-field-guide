import test from "node:test";
import assert from "node:assert/strict";
import { createConfiguredSourceWorkerIdentity, createDshSourceModel, createPostgresSourceRunQueue, createSourceQueueRunner } from "./worker-factory.ts";
import type { DeepSeekHarnessAdapter, DeepSeekHarnessGenerationRequest } from "./deepseek-harness.ts";
import { DomainError } from "../../shared/errors.ts";

test("source identity authenticates its own credential and only returns explicit source scopes", async () => {
  const identities = createConfiguredSourceWorkerIdentity({ workerId: "backend-source", serviceCredential: "fixture-service-secret", sourceConfigIds: async () => ["approved-source"] });
  assert.equal(await identities.authenticate("website-session"), null);
  assert.deepEqual(await identities.authenticate("fixture-service-secret"), { id: "backend-source", kind: "operations_worker", capabilities: ["crawl", "analysis"], sourceConfigIds: ["approved-source"] });
});
test("source model maps to the actual DSH port with fixed model, schema and prompt versions", async () => {
  let received: unknown;
  const model = createDshSourceModel({ identity: { modelVersion: "fixed-model", promptVersion: "fixed-prompt", harnessVersion: "pinned" },
    async generate(input: DeepSeekHarnessGenerationRequest) { received = input; return { data: { fields: [] }, usage: { inputTokens: 3, outputTokens: 4, estimatedCostMicros: 5, currency: "USD" } }; },
  } as unknown as DeepSeekHarnessAdapter);
  const signal = new AbortController().signal;
  const output = await model.generateJson({ taskId: "run", task: "source_crawl", schemaVersion: "source-extraction-v1", prompt: "Only JSON", input: {}, signal });
  assert.deepEqual(received, { taskId: "run", purpose: "event_extraction", schemaVersion: "source-extraction-v1", modelVersion: "fixed-model", promptVersion: "fixed-prompt", systemPrompt: "Only JSON", input: {}, signal });
  assert.equal(output.usage.inputTokens, 3);
});
test("queue uses SQL due-state filters and runner continues after another worker claimed a task", async () => {
  const calls: { statement: string; parameters: readonly unknown[] }[] = [];
  const queue = createPostgresSourceRunQueue({ async query<Row>(statement: string, parameters: readonly unknown[] = []) {
    calls.push({ statement, parameters }); return { rows: [{ id: "already-claimed" }, { id: "due-task" }] as Row[], rowCount: 2 };
  }, transaction: async work => { throw new Error("unused"); } });
  const control = new AbortController();
  const runner = createSourceQueueRunner({ clock: { now: () => new Date("2026-10-08T08:00:00Z") }, queue,
    worker: { async execute(id) { if (id === "already-claimed") throw new DomainError("RUN_NOT_CLAIMABLE", "已被领取", { status: 409 });
      return { id, kind: "crawl", status: "review_ready", step: "complete", revision: 3, attempt: 1, availableAt: "2026-10-08T08:00:00Z", finishedAt: "2026-10-08T08:00:00Z", deadlineAt: null, leaseExpiresAt: null }; } } });
  const report = await runner.runOnce(); assert.equal(report.runs[0]?.id, "due-task"); assert.equal(report.errors[0]?.code, "RUN_NOT_CLAIMABLE");
  assert.match(calls[0]!.statement, /status='queued'.*available_at<=\$1/); assert.deepEqual(calls[0]!.parameters, ["2026-10-08T08:00:00.000Z", ["crawl", "analysis"], 5]);
  await runner.loop({ signal: control.signal, onCycle: () => { control.abort(); } });
});
