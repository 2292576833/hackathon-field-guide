import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { test } from "node:test";
import { driveDshRuntime, type DeepSeekHarnessGenerationRequest } from "../modules/operations/deepseek-harness.ts";
import { DomainError } from "../shared/errors.ts";

/** A wire-only fixture: no process, provider, account grant, filesystem or database. */
function lifecycleFixture(options: { exitDelay?: number; closeDelay?: number; holdModel?: boolean; neverExit?: boolean } = {}) {
  const owner = new EventEmitter();
  const stdout = new PassThrough(), stderr = new PassThrough();
  const signals: string[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let exited = false, closed = false;
  const childState = { exitCode: null as number | null, signalCode: null as NodeJS.Signals | null };
  const later = (callback: () => void, delay: number) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
    timers.add(timer);
  };
  const emitClose = () => {
    if (closed) return;
    closed = true;
    stdout.end(); stderr.end();
    owner.emit("close", childState.exitCode, childState.signalCode);
  };
  const emitExit = (code: number | null, signal: NodeJS.Signals | null = null) => {
    if (exited) return;
    exited = true;
    childState.exitCode = code; childState.signalCode = signal;
    owner.emit("exit", code, signal);
  };
  const frame = (value: Record<string, unknown>) => stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
  const event = (sessionId: string, type: string, data: Record<string, unknown>) => frame({ method: "session.event", params: { sessionId, event: { type, data } } });
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      const request = JSON.parse(chunk.toString()) as { id: number; method: string; params?: { sessionId?: string } };
      later(() => {
        if (request.method === "initialize") {
          frame({ id: request.id, result: { serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.0.1" } } });
        } else if (request.method === "session/prompt") {
          const sessionId = request.params!.sessionId!;
          frame({ id: request.id, result: { messageId: "fixture-receipt" } });
          event(sessionId, "agent/inbox/spliced", { inserted: [{ id: "fixture-receipt" }] });
          if (options.holdModel) return;
          event(sessionId, "request/header", { header: { tools: [] } });
          event(sessionId, "assistant/message", { message: { content: [{ type: "text", text: '{"ok":true}' }] }, usage: { inputTokens: 7, outputTokens: 3 } });
          event(sessionId, "turn/end", { reason: { kind: "completed" } });
          frame({ method: "session.status", params: { sessionId, status: "idle" } });
        } else if (request.method === "shutdown") {
          frame({ id: request.id, result: {} });
          if (options.neverExit) return;
          later(() => emitExit(0), options.exitDelay ?? 5);
          if (options.closeDelay !== undefined) later(emitClose, options.closeDelay);
        }
      }, 1);
      callback();
    },
  });
  const child = Object.assign(owner, {
    stdin, stdout, stderr,
    get exitCode() { return childState.exitCode; },
    get signalCode() { return childState.signalCode; },
    kill(signal: NodeJS.Signals = "SIGTERM") {
      signals.push(signal);
      if (exited || options.neverExit) return false;
      later(() => {
        emitExit(null, signal);
        if (options.closeDelay !== undefined) emitClose();
      }, 1);
      return true;
    },
  }) as unknown as ChildProcessWithoutNullStreams;
  // Object.assign eagerly evaluates getters; mimic actual ChildProcess's updated status fields.
  Object.defineProperties(child, {
    exitCode: { get: () => childState.exitCode },
    signalCode: { get: () => childState.signalCode },
  });
  return {
    child, signals, stdout, stderr,
    cleanup() { for (const timer of timers) clearTimeout(timer); timers.clear(); stdin.destroy(); stdout.destroy(); stderr.destroy(); },
  };
}

function request(signal = new AbortController().signal): DeepSeekHarnessGenerationRequest {
  return { taskId: "fixture-lifecycle", purpose: "navigator", schemaVersion: "fixture-v1", modelVersion: "fixture-model", promptVersion: "fixture-prompt", systemPrompt: "wire fixture only", input: {}, signal };
}
const limits = { timeoutMs: 10_000, maxTokens: 100, maxTransportBytes: 65_536, maxJsonOutputBytes: 1024 };

test("confirmed process exit with delayed pipe closure does not misreport a living DSH process", async () => {
  const f = lifecycleFixture({ exitDelay: 5 });
  try {
    const result = await driveDshRuntime(f.child, request(), "fixture-only", "{}", limits);
    assert.deepEqual(result, { text: '{"ok":true}', inputTokens: 7, outputTokens: 3 });
    assert.deepEqual(f.signals, [], "an exited process must not receive force-kill attempts");
  } finally { f.cleanup(); }
});

test("a completed SDK shutdown may take 500ms without being force-killed at 250ms", async () => {
  const f = lifecycleFixture({ exitDelay: 500, closeDelay: 510 });
  try {
    const result = await driveDshRuntime(f.child, request(), "fixture-only", "{}", limits);
    assert.equal(result.text, '{"ok":true}');
    assert.deepEqual(f.signals, [], "official shutdown has a 5-second grace window");
  } finally { f.cleanup(); }
});

test("confirmed cancellation exit preserves cancellation when pipes close later", async () => {
  const controller = new AbortController(), f = lifecycleFixture({ holdModel: true });
  const cancel = setTimeout(() => controller.abort(), 30);
  try {
    await assert.rejects(driveDshRuntime(f.child, request(controller.signal), "fixture-only", "{}", limits), (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "DSH_CANCELLED");
      return true;
    });
    assert.deepEqual(f.signals, ["SIGTERM"]);
  } finally { clearTimeout(cancel); f.cleanup(); }
});

test("a runtime with no confirmed process exit remains a termination failure", async () => {
  const controller = new AbortController(), f = lifecycleFixture({ holdModel: true, neverExit: true });
  const cancel = setTimeout(() => controller.abort(), 30);
  try {
    await assert.rejects(driveDshRuntime(f.child, request(controller.signal), "fixture-only", "{}", limits), (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "DSH_TERMINATION_FAILED");
      return true;
    });
    assert.ok(f.signals.includes("SIGKILL"));
  } finally { clearTimeout(cancel); f.cleanup(); }
});
