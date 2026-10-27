import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { bindWebWorkerCancellation } from "./web-worker-signals.ts";

test("web shutdown starts cancellation before framework cleanup and repeated signals cannot duplicate work", async () => {
  const signals = new EventEmitter(), order: string[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  signals.on("SIGINT", () => { order.push("next-http-drain"); });
  const unbind = bindWebWorkerCancellation({ async stop() { order.push("worker-cancel"); await held; } }, signals);
  signals.emit("SIGINT"); signals.emit("SIGTERM");
  assert.deepEqual(order, ["worker-cancel", "next-http-drain"]);
  release(); await held;
  unbind();
  signals.emit("SIGINT");
  assert.deepEqual(order, ["worker-cancel", "next-http-drain", "next-http-drain"]);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});
