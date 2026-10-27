import test from "node:test";
import assert from "node:assert/strict";
import { createRequestDrain, drainAndClose } from "./request-drain.ts";
test("shutdown rejects new requests and closes only after accepted writes and workers finish", async () => {
  const requests = createRequestDrain();
  let releaseRequest!: () => void, releaseWorker!: () => void;
  const requestWait = new Promise<void>(resolve => { releaseRequest = resolve; });
  const workerWait = new Promise<void>(resolve => { releaseWorker = resolve; });
  const order: string[] = [];
  const accepted = requests.run(async () => { await requestWait; order.push("write"); return 42; });
  const stopped = drainAndClose({ requests, workers: { async stop() { await workerWait; order.push("workers"); } }, async close() { order.push("close"); } });
  await assert.rejects(requests.run(async () => 1), /SERVER_STOPPING/);
  releaseWorker(); await Promise.resolve(); assert.deepEqual(order, ["workers"]);
  releaseRequest(); assert.equal(await accepted, 42); await stopped;
  assert.deepEqual(order, ["workers", "write", "close"]);
});
test("failed accepted request releases its gate and close failure propagates", async () => {
  const requests = createRequestDrain();
  await assert.rejects(requests.run(async () => { throw new Error("write_failed"); }), /write_failed/);
  await assert.rejects(drainAndClose({ requests, async close() { throw new Error("close_failed"); } }), /close_failed/);
});
