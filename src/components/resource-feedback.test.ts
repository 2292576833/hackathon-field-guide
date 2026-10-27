import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import type { Actor } from "../shared/contracts.ts";
import type { ResourceInput } from "../modules/resources/domain.ts";
import { createResourceFeedbackClient, resourceCorrectionInput, type ResourceCorrectionView } from "../modules/resources/feedback-client.ts";
import { createApplication } from "../server/application.ts";
import { createDatabase } from "../server/database.ts";
import { dispatch } from "../server/router.ts";

const origin = "http://localhost:3000";
const alice: Actor = { userId: "feedback-alice", platformRoles: ["user"] };
const bob: Actor = { userId: "feedback-bob", platformRoles: ["user"] };
const admin: Actor = { userId: "feedback-admin", platformRoles: ["admin"] };
async function fixture() {
  // Fresh real SQL engine; no env, worker, model, SMTP or production database.
  const database = await createDatabase({});
  let app: Awaited<ReturnType<typeof createApplication>>;
  try { app = await createApplication({ mode: "local", origin, codePepper: "resource-feedback-isolated-test-only", emailFrom: "test@example.test" }, database); }
  catch (error) { await database.close(); throw error; }
  const tokens = new Map<string, string>(), now = app.clock.now().toISOString();
  for (const actor of [alice, bob, admin]) {
    await database.query("INSERT INTO auth_users(id,email,display_name,timezone,platform_roles,email_verified_at,created_at) VALUES($1,$2,$1,'Asia/Shanghai',$3,$4,$4)", [actor.userId, `${actor.userId}@example.test`, actor.platformRoles, now]);
    const token = randomBytes(32).toString("base64url"); tokens.set(actor.userId, token);
    await database.query("INSERT INTO auth_sessions(id,user_id,token_hash,created_at,authenticated_at,expires_at) VALUES($1,$2,$3,$4,$4,$5)", [actor.userId, actor.userId, createHash("sha256").update(token).digest("hex"), now, new Date(app.clock.now().getTime() + 3600000).toISOString()]);
  }
  async function request<T>(actor: Actor | null, path: string, method = "GET", body?: unknown, expectedStatus = 200, requestOrigin = origin): Promise<T> {
    const headers = new Headers({ Origin: requestOrigin }); if (actor) headers.set("Cookie", `hackathon_session=${tokens.get(actor.userId)}`);
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const response = await dispatch(app, new Request(`${origin}/api/v1/${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), path.split("?")[0]!.split("/"));
    const envelope = await response.json() as { data: T; error?: { message: string; code: string } };
    assert.equal(response.status, expectedStatus, `${method} ${path}: ${envelope.error?.code ?? "unexpected status"}`);
    if (response.status >= 400) throw Object.assign(new Error(envelope.error!.message), { status: response.status, code: envelope.error!.code });
    assert.match(response.headers.get("Cache-Control") ?? "", /(?:^|,\s*)no-store(?:,|$)/);
    return envelope.data;
  }
  const resource: ResourceInput = {
    name: "隔离反馈测试资源", officialUrl: "https://example.test/resource", type: "practical_tool",
    stageTags: ["development"], useTags: ["development"], stackTags: ["stack_agnostic"], prerequisites: ["browse"],
    summary: "只验证实际根路由反馈，不访问此 URL", suitableFor: "测试", notSuitableFor: "实际参赛推荐", quickStart: ["不调用外站"],
    costType: "unknown", costNote: "未说明", costSourceUrl: null, costVerifiedAt: null,
    licenseStatus: "unknown", licenseNote: "未说明", licenseSourceUrl: null, licenseVerifiedAt: null,
    verifiedAt: now, linkStatus: "available", displayOrder: 1,
  };
  const draft = await app.resources.createDraft(admin, resource);
  const submitted = await request<{ resource: { revision: number }; review: { id: string; revision: number } }>(admin, `admin/resources/${draft.id}/request-review`, "POST", { expectedRevision: draft.revision });
  const approved = await app.operations.services.resourceReview.decide(admin, submitted.review.id, {
    expectedRevision: submitted.review.revision, expectedResourceRevision: submitted.resource.revision, decision: "approved", reason: "隔离测试明示费用与许可未知。",
    verification: { link: { status: "available", checkedUrl: resource.officialUrl }, fees: { status: "unknown", sourceUrl: null }, license: { status: "unknown", sourceUrl: null } },
  }, "isolated-feedback-review");
  await app.operations.services.resourceReview.publish(admin, approved.id, { expectedRevision: approved.revision, expectedResourceRevision: submitted.resource.revision }, "isolated-feedback-publish");
  return { app, database, request, resource: await app.resources.detail(draft.id) };
}

test("actual resource feedback UI transport uses the one M08 root queue and private replies without changing the resource", async t => {
  const f = await fixture(); t.after(() => f.database.close());
  const input = resourceCorrectionInput(f.resource, "费用说明不准确", "PRIVATE_FEEDBACK_SENTINEL：请核查费用变化", "https://example.test/pricing");
  const client = createResourceFeedbackClient(alice.userId, {
    list: () => f.request(alice, "me/corrections?limit=100"), detail: id => f.request(alice, `me/corrections/${id}`),
    submit: body => f.request(alice, "corrections", "POST", body, 201),
  });
  const saved = await client.submit(input); assert.ok(saved);
  assert.equal((await f.database.query("SELECT id FROM operations_corrections")).rowCount, 1);
  assert.deepEqual(await f.app.resources.detail(f.resource.id), f.resource, "a feedback submission is not a publication or a content mutation");
  await f.request(admin, `admin/corrections/${saved.id}`, "PATCH", { expectedRevision: saved.revision, status: "triaging", reason: "开始核查。" });
  await f.request(admin, `admin/corrections/${saved.id}`, "PATCH", { expectedRevision: saved.revision + 1, status: "confirmed", reason: "已采纳，等待费用页面复核发布。" });
  await client.load(); await client.select(saved.id);
  assert.equal(client.getSnapshot().selected?.status, "confirmed"); assert.match(client.getSnapshot().selected!.response!, /已采纳/);
  await assert.rejects(() => f.request(bob, `me/corrections/${saved.id}`, "GET", undefined, 404), { code: "NOT_FOUND" });
  assert.deepEqual(await f.request(bob, `me/corrections?userId=${alice.userId}&limit=100`), [], "query userId cannot widen the private owner scope");
  await assert.rejects(() => f.request(null, "corrections", "POST", input, 401));
  await assert.rejects(() => f.request(alice, "corrections", "POST", input, 403, "https://foreign.example.test"));
  assert.equal((await f.database.query("SELECT id FROM operations_corrections")).rowCount, 1);
  assert.equal((await f.database.query("SELECT id FROM ai_execution_jobs")).rowCount, 0);
});

test("revoking the actual root session makes the feedback client clear cached private records and stop new writes", async t => {
  const f = await fixture(); t.after(() => f.database.close());
  const input = resourceCorrectionInput(f.resource, "链接失效", "请核查该资源链接", "");
  const saved = await f.request<ResourceCorrectionView>(alice, "corrections", "POST", input, 201);
  let afterRevocation = false;
  const client = createResourceFeedbackClient(alice.userId, {
    list: () => f.request(alice, "me/corrections?limit=100", "GET", undefined, afterRevocation ? 401 : 200),
    detail: id => f.request(alice, `me/corrections/${id}`), submit: body => f.request(alice, "corrections", "POST", body, 201),
  });
  await client.load(); await client.select(saved.id); assert.ok(client.getSnapshot().selected);
  await f.database.query("UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1", [alice.userId]); afterRevocation = true;
  await client.load(); assert.deepEqual(client.getSnapshot().items, []); assert.equal(client.getSnapshot().selected, null);
  assert.equal(client.getSnapshot().accessLost, true); assert.equal(await client.submit(input), null);
  assert.equal((await f.database.query("SELECT id FROM operations_corrections")).rowCount, 1);
});
