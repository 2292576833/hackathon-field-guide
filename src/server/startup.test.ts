import test from "node:test";
import assert from "node:assert/strict";
import { bootstrapWebServer } from "./startup.ts";

test("web bootstrap never loads application services during builds, Edge registration or an unset serve flag", async () => {
  let loads = 0;
  const load = async () => { loads++; throw new Error("application must stay unloaded"); };
  for (const input of [
    { runtime: "nodejs", serving: "" },
    { runtime: "nodejs", serving: "0" },
    { runtime: "nodejs", serving: "true" },
    { runtime: "edge", serving: "1" },
    { runtime: "", serving: "1" },
  ]) assert.equal(await bootstrapWebServer({ ...input, load }), false);
  assert.equal(loads, 0);
});

test("Node serve bootstrap awaits application startup once before reporting readiness", async () => {
  const calls: string[] = [];
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  let completed = false;
  const bootstrap = bootstrapWebServer({ runtime: "nodejs", serving: "1", load: async () => {
    calls.push("load");
    return { async start() { calls.push("start"); await ready; calls.push("ready"); } };
  } }).then(value => { completed = true; return value; });
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(calls, ["load", "start"]);
  assert.equal(completed, false);
  release();
  assert.equal(await bootstrap, true);
  assert.deepEqual(calls, ["load", "start", "ready"]);
});

test("web bootstrap propagates loading and startup failures instead of declaring the server ready", async () => {
  const loadFailure = new Error("isolated loader failure");
  await assert.rejects(bootstrapWebServer({ runtime: "nodejs", serving: "1", load: async () => { throw loadFailure; } }), error => error === loadFailure);
  const startFailure = new Error("isolated startup failure");
  await assert.rejects(bootstrapWebServer({ runtime: "nodejs", serving: "1", load: async () => ({ async start() { throw startFailure; } }) }), error => error === startFailure);
});
