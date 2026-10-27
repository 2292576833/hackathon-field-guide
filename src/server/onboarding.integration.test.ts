import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import type { Actor } from "../shared/contracts.ts";
import { FIRST_LOGIN_GUIDE_STEP_COUNT, FIRST_LOGIN_GUIDE_VERSION, type OnboardingState } from "../modules/onboarding/index.ts";
import { createApplication } from "./application.ts";
import { createDatabase } from "./database.ts";
import { dispatch } from "./router.ts";

const origin = "http://localhost:3000";
const alice: Actor = { userId: "onboarding-alice", platformRoles: ["user"] };
const bob: Actor = { userId: "onboarding-bob", platformRoles: ["user"] };
const initial: OnboardingState = { version: FIRST_LOGIN_GUIDE_VERSION, stepIndex: 0, completedAt: null, revision: 0 };

async function fixture() {
  // Deliberately no localPath, connection URL or environment config: this is an isolated real database.
  const database = await createDatabase({});
  const app = await createApplication({ mode: "local", origin, codePepper: "onboarding-integration-isolated-pepper-only", emailFrom: "test@example.test" }, database);
  const now = app.clock.now().toISOString();
  const tokens = new Map<string, string>();
  for (const actor of [alice, bob]) {
    await database.query("INSERT INTO auth_users(id,email,display_name,timezone,status,platform_roles,email_verified_at,created_at,revision) VALUES($1,$2,$3,'Asia/Shanghai','active',$4,$5,$5,1)",
      [actor.userId, `${actor.userId}@example.test`, actor.userId, actor.platformRoles, now]);
    const token = randomBytes(32).toString("base64url");
    tokens.set(actor.userId, token);
    await database.query("INSERT INTO auth_sessions(id,user_id,token_hash,created_at,authenticated_at,expires_at) VALUES($1,$2,$3,$4,$4,$5)",
      [`${actor.userId}-session`, actor.userId, createHash("sha256").update(token).digest("hex"), now, new Date(app.clock.now().getTime() + 3_600_000).toISOString()]);
  }
  async function request(actor: Actor | null, method = "GET", body?: unknown, expectedStatus = 200, options: { origin?: string; query?: string } = {}) {
    const headers = new Headers({ Origin: options.origin ?? origin });
    if (actor) headers.set("Cookie", `hackathon_session=${tokens.get(actor.userId)}`);
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const incoming = new Request(`${origin}/api/v1/me/onboarding${options.query ?? ""}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const response = await dispatch(app, incoming, ["me", "onboarding"]);
    const envelope = await response.json() as { data: OnboardingState; error?: { code: string; latestRevision?: number }; requestId: string };
    // Credentials and request bodies must never appear in assertion diagnostics.
    assert.equal(response.status, expectedStatus, `${method} me/onboarding: ${envelope.error?.code ?? "unexpected status"}`);
    assert.ok(envelope.requestId);
    return { ...envelope, response };
  }
  const rows = () => database.query("SELECT user_id,version,step_index,completed_at,revision,updated_at FROM user_onboarding ORDER BY user_id");
  return { app, database, request, rows };
}

test("onboarding dispatch applies migration 027, rejects anonymous access and leaves first GET read-only", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.database.query("SELECT id FROM application_migrations WHERE id='027_user_onboarding.sql'")).rowCount, 1);
    await f.request(null, "GET", undefined, 401);
    await f.request(null, "POST", { expectedRevision: 0, stepIndex: 1 }, 401);
    for (const actor of [alice, bob, alice]) {
      const result = await f.request(actor);
      assert.deepEqual(result.data, initial);
      assert.equal(result.response.headers.get("Cache-Control"), "private, no-store");
    }
    assert.equal((await f.rows()).rowCount, 0, "reading a guide does not create a progress/completion record");
  } finally { await f.database.close(); }
});

test("onboarding steps persist per account and query/body identity cannot address another user's guide", async () => {
  const f = await fixture();
  try {
    const aliceStep = (await f.request(alice, "POST", { expectedRevision: 0, stepIndex: 2 })).data;
    assert.deepEqual(aliceStep, { ...initial, stepIndex: 2, revision: 1 });
    assert.deepEqual((await f.request(bob, "GET", undefined, 200, { query: `?userId=${alice.userId}` })).data, initial);
    const bobStep = (await f.request(bob, "POST", { expectedRevision: 0, stepIndex: 1, userId: alice.userId })).data;
    assert.deepEqual(bobStep, { ...initial, stepIndex: 1, revision: 1 });
    const snapshot = (await f.rows()).rows;
    assert.deepEqual((await f.request(alice)).data, aliceStep);
    assert.deepEqual((await f.request(bob)).data, bobStep);
    assert.deepEqual((await f.rows()).rows, snapshot, "GET must not alter saved guide state or timestamps");
    assert.deepEqual(Object.keys(aliceStep).sort(), ["completedAt", "revision", "stepIndex", "version"], "the guide DTO has no account/session internals");
  } finally { await f.database.close(); }
});

test("onboarding completion requires the last step, is idempotent and cannot be reset by replay", async () => {
  const f = await fixture();
  try {
    const premature = await f.request(alice, "POST", { expectedRevision: 0, stepIndex: 1, completed: true }, 422);
    assert.equal(premature.error?.code, "ONBOARDING_NOT_AT_LAST_STEP");
    assert.equal((await f.rows()).rowCount, 0);
    const completed = (await f.request(alice, "POST", { expectedRevision: 0, stepIndex: FIRST_LOGIN_GUIDE_STEP_COUNT - 1, completed: true })).data;
    assert.equal(completed.revision, 1);
    assert.ok(completed.completedAt && Number.isFinite(Date.parse(completed.completedAt)));
    const snapshot = (await f.rows()).rows;
    assert.deepEqual((await f.request(alice, "POST", { expectedRevision: 1, stepIndex: 5, completed: true })).data, completed);
    assert.deepEqual((await f.request(alice, "POST", { expectedRevision: 1, stepIndex: 0, completed: false })).data, completed);
    assert.deepEqual((await f.request(alice)).data, completed);
    assert.deepEqual((await f.rows()).rows, snapshot, "replay must not change completion time, revision or step");
    assert.deepEqual((await f.request(bob)).data, initial);
  } finally { await f.database.close(); }
});

test("onboarding stale writes return 409 and wrong Origin or malformed steps cannot overwrite progress", async () => {
  const f = await fixture();
  try {
    await f.request(alice, "POST", { expectedRevision: 0, stepIndex: 1 });
    const newest = (await f.request(alice, "POST", { expectedRevision: 1, stepIndex: 3 })).data;
    const stale = await f.request(alice, "POST", { expectedRevision: 1, stepIndex: 0 }, 409);
    assert.equal(stale.error?.code, "ONBOARDING_REVISION_CONFLICT");
    assert.equal(stale.error?.latestRevision, 2);
    const snapshot = (await f.rows()).rows;
    const rejectedOrigin = await f.request(alice, "POST", { expectedRevision: 2, stepIndex: 4 }, 403, { origin: "https://untrusted.example.test" });
    assert.equal(rejectedOrigin.error?.code, "ORIGIN_FORBIDDEN");
    for (const body of [
      { expectedRevision: 2, stepIndex: -1 }, { expectedRevision: 2, stepIndex: 6 },
      { expectedRevision: 2, stepIndex: 1.5 }, { expectedRevision: -1, stepIndex: 1 },
      { expectedRevision: 2, stepIndex: 1, completed: "yes" },
    ]) await f.request(alice, "POST", body, 422);
    await f.request(alice, "PATCH", { expectedRevision: 2, stepIndex: 4 }, 405);
    assert.deepEqual((await f.request(alice)).data, newest);
    assert.deepEqual((await f.rows()).rows, snapshot);
  } finally { await f.database.close(); }
});

test("revoked sessions and disabled accounts cannot read or write onboarding state", async () => {
  const f = await fixture();
  try {
    await f.request(alice, "POST", { expectedRevision: 0, stepIndex: 2 });
    await f.request(bob, "POST", { expectedRevision: 0, stepIndex: 1 });
    const snapshot = (await f.rows()).rows;
    await f.database.query("UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1", [alice.userId]);
    await f.database.query("UPDATE auth_users SET status='suspended' WHERE id=$1", [bob.userId]);
    for (const actor of [alice, bob]) {
      await f.request(actor, "GET", undefined, 401);
      await f.request(actor, "POST", { expectedRevision: 1, stepIndex: 5, completed: true }, 401);
    }
    assert.deepEqual((await f.rows()).rows, snapshot);
  } finally { await f.database.close(); }
});

test("dispatch rechecks account and session after an initially valid actor resolution", async () => {
  const f = await fixture();
  try {
    const resolve = f.app.resolveActor;
    let revokeOnce = true;
    f.app.resolveActor = async request => {
      const current = await resolve(request);
      if (revokeOnce && current?.userId === alice.userId) {
        revokeOnce = false;
        await f.database.query("UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1", [alice.userId]);
      }
      return current;
    };
    await f.request(alice, "POST", { expectedRevision: 0, stepIndex: 1 }, 401);
    let disableOnce = true;
    f.app.resolveActor = async request => {
      const current = await resolve(request);
      if (disableOnce && current?.userId === bob.userId) {
        disableOnce = false;
        await f.database.query("UPDATE auth_users SET status='suspended' WHERE id=$1", [bob.userId]);
      }
      return current;
    };
    await f.request(bob, "GET", undefined, 401);
    assert.equal((await f.rows()).rowCount, 0, "stale identity cannot initialize or finish the guide");
  } finally { await f.database.close(); }
});
