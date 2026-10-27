import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "../../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { DomainError } from "../../shared/errors.ts";
import { FIRST_LOGIN_GUIDE_STEP_COUNT, firstLoginSteps } from "./model.ts";
import { OnboardingService } from "./service.ts";

const alice: Actor = { userId: "guide-alice", platformRoles: ["user"] };
const bob: Actor = { userId: "guide-bob", platformRoles: ["user"] };
const now = "2026-10-09T11:30:00.000Z";

async function fixture() {
  const engine = new PGlite();
  await engine.waitReady;
  await engine.exec("CREATE TABLE auth_users (id text PRIMARY KEY); INSERT INTO auth_users (id) VALUES ('guide-alice'),('guide-bob');");
  await engine.exec(await readFile(new URL("./schema.sql", import.meta.url), "utf8"));
  function executor(query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>): SqlExecutor {
    return { async query<Row>(sql: string, params: readonly unknown[] = []) {
      const result = await query(sql, [...params]);
      return { rows: result.rows as Row[], rowCount: result.affectedRows ?? result.rows.length };
    } };
  }
  const database: DatabasePort = {
    ...executor((sql, params) => engine.query(sql, params)),
    transaction: work => engine.transaction(tx => work(executor((sql, params) => tx.query(sql, params)))),
  };
  return { database, service: new OnboardingService(database, { now: () => new Date(now) }), close: () => engine.close() };
}

test("first GET is read-only and both accounts receive independent initial states", async () => {
  const f = await fixture();
  try {
    const initial = await f.service.get(alice);
    assert.deepEqual(initial, { version: "first-login-v1", stepIndex: 0, completedAt: null, revision: 0 });
    assert.deepEqual(await f.service.get(bob), initial);
    assert.equal((await f.database.query<{ count: number }>("SELECT count(*)::int AS count FROM user_onboarding")).rows[0]?.count, 0);
  } finally { await f.close(); }
});

test("steps resume across service instances without affecting another account", async () => {
  const f = await fixture();
  try {
    await f.service.save(alice, { expectedRevision: 0, stepIndex: 2 });
    const resumed = await new OnboardingService(f.database, { now: () => new Date(now) }).get(alice);
    assert.equal(resumed.stepIndex, 2); assert.equal(resumed.revision, 1);
    assert.equal((await f.service.get(bob)).revision, 0);
    await f.service.save(bob, { expectedRevision: 0, stepIndex: 1 });
    assert.equal((await f.service.get(alice)).stepIndex, 2);
  } finally { await f.close(); }
});

test("two initial writes with revision zero have exactly one winner", async () => {
  const f = await fixture();
  try {
    const writes = await Promise.allSettled([
      f.service.save(alice, { expectedRevision: 0, stepIndex: 1 }),
      f.service.save(alice, { expectedRevision: 0, stepIndex: 2 }),
    ]);
    assert.equal(writes.filter(result => result.status === "fulfilled").length, 1);
    const rejected = writes.find(result => result.status === "rejected") as PromiseRejectedResult;
    assert.equal(rejected.reason.code, "ONBOARDING_REVISION_CONFLICT");
    assert.equal(rejected.reason.status, 409);
    assert.equal((await f.service.get(alice)).revision, 1);
  } finally { await f.close(); }
});

test("stale update cannot replace newer progress and rollback keeps the winner", async () => {
  const f = await fixture();
  try {
    await f.service.save(alice, { expectedRevision: 0, stepIndex: 1 });
    await f.service.save(alice, { expectedRevision: 1, stepIndex: 3 });
    await assert.rejects(f.service.save(alice, { expectedRevision: 1, stepIndex: 0 }), error => error instanceof DomainError && error.latestRevision === 2);
    assert.equal((await f.service.get(alice)).stepIndex, 3);
  } finally { await f.close(); }
});

test("completion requires the final step and cannot be undone by replay", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.save(alice, { expectedRevision: 0, stepIndex: 1, completed: true }), error => error instanceof DomainError && error.code === "ONBOARDING_NOT_AT_LAST_STEP");
    const done = await f.service.save(alice, { expectedRevision: 0, stepIndex: 5, completed: true });
    assert.equal(done.completedAt, now);
    assert.equal(done.stepIndex, 5);
    assert.deepEqual(await f.service.save(alice, { expectedRevision: done.revision, stepIndex: 0, completed: false }), done);
    assert.deepEqual(await f.service.get(alice), done);
  } finally { await f.close(); }
});

test("malformed revisions, steps, completion flags and missing actor are rejected before writing", async () => {
  const f = await fixture();
  try {
    for (const stepIndex of [-1, 6, 1.5, NaN]) await assert.rejects(f.service.save(alice, { expectedRevision: 0, stepIndex }), error => error instanceof DomainError && error.status === 422);
    for (const expectedRevision of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(f.service.save(alice, { expectedRevision, stepIndex: 0 }));
    await assert.rejects(f.service.save(alice, { expectedRevision: 0, stepIndex: 0, completed: "yes" as unknown as boolean }));
    await assert.rejects(f.service.get({ ...alice, userId: "" }), error => error instanceof DomainError && error.status === 401);
    assert.equal((await f.service.get(alice)).revision, 0);
  } finally { await f.close(); }
});

test("the six guide steps distinguish evidence, consent and save/run/formal submission", () => {
  assert.equal(firstLoginSteps.length, FIRST_LOGIN_GUIDE_STEP_COUNT);
  assert.ok(firstLoginSteps.every(step => step.actions.length === 2 && step.reminder.length > 15));
  assert.match(firstLoginSteps[1].reminder, /不等于完成报名/);
  assert.match(firstLoginSteps[2].reminder, /明确选择/);
  assert.match(firstLoginSteps[5].reminder, /三件不同的事/);
});
