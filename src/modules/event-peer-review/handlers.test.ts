import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../shared/errors.ts";
import type { OrganizerPrincipal } from "../../shared/organizer-contracts.ts";
import { createEventPeerReviewHandlers } from "./handlers.ts";
import type { EventPeerReviewService } from "./service.ts";

/** HTTP 边界的固化：真实 principal、CSRF、方法、正文与路由标识；并确认没有评委侧入口。 */
function fixture(authenticated = true, denyMutation = false) {
  const calls: string[] = []; let seq = 0;
  const principal: OrganizerPrincipal = { actor: { userId: "real-user", platformRoles: ["user"] }, guard: async () => {} };
  const service = {
    getWork: async (p: OrganizerPrincipal, eventId: string, snapshotId: string) => { calls.push("get"); return { eventId, snapshotId, by: p.actor.userId }; },
    submitMyReview: async (p: OrganizerPrincipal, eventId: string, snapshotId: string, input: unknown) => { calls.push("submit"); return { eventId, snapshotId, by: p.actor.userId, input }; },
    withdrawMyReview: async (_p: OrganizerPrincipal, eventId: string, snapshotId: string, input: unknown) => { calls.push("withdraw"); return { eventId, snapshotId, input }; },
    reportReview: async (_p: OrganizerPrincipal, eventId: string, snapshotId: string, reviewId: string, input: unknown) => { calls.push("report"); return { eventId, snapshotId, reviewId, input }; },
  } as unknown as EventPeerReviewService;
  return { calls, handlers: createEventPeerReviewHandlers({
    service,
    resolvePrincipal: async () => { calls.push("resolve"); return authenticated ? principal : null; },
    authorizeMutation: async () => { calls.push("csrf"); if (denyMutation) throw new DomainError("ORIGIN_REJECTED", "来源不符。", { status: 403 }); },
    requestIds: { next: () => "request-" + String(++seq) },
  }) };
}
const snapshot = { eventId: "A", snapshotId: "snap-1" };
const json = (body: unknown, url = "https://site.test/api/v1/competitions/A/works/snap-1/peer-review", headers: Record<string, string> = {}) =>
  new Request(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

test("模块只暴露四条选手侧端点，没有任何评委侧入口", () => {
  const { handlers } = fixture();
  assert.deepEqual(Object.keys(handlers).sort(), ["reportPeerReview", "submitPeerReview", "withdrawPeerReview", "workPeerReview"]);
  for (const name of Object.keys(handlers)) assert.ok(!/judge|score|result|aggregate|export/i.test(name), "不得出现评委侧/名次/导出入口：" + name);
});

test("读入口由真实 principal 解析，匿名 401、方法错误 405、越权在业务之前被拦", async () => {
  const { calls, handlers } = fixture();
  const response = await handlers.workPeerReview(new Request("https://site.test/api/v1/competitions/A/works/snap-1/peer-review"), snapshot);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { eventId: "A", snapshotId: "snap-1", by: "real-user" }, requestId: "request-1" });
  assert.deepEqual(calls, ["resolve", "get"]);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);

  const anonymous = fixture(false);
  assert.equal((await anonymous.handlers.workPeerReview(new Request("https://site.test/x"), snapshot)).status, 401);
  assert.deepEqual(anonymous.calls, ["resolve"]);

  assert.equal((await handlers.workPeerReview(new Request("https://site.test/x", { method: "POST" }), snapshot)).status, 405);
  const denied = fixture(true, true);
  assert.equal((await denied.handlers.submitPeerReview(json({ values: { d1: 4 }, idempotencyKey: "k" }), snapshot)).status, 403);
  assert.deepEqual(denied.calls, ["resolve", "csrf"]);
});

test("写入口用真实 principal 与请求正文，不采信自称账号；重试标识头与正文不一致拒绝", async () => {
  const { calls, handlers } = fixture();
  const response = await handlers.submitPeerReview(json({ actor: { userId: "other" }, values: { d1: 4, d2: 5 }, idempotencyKey: "k" }), snapshot);
  assert.equal(response.status, 200);
  const payload = await response.json() as { data: { by: string; input: { values: Record<string, number> } } };
  assert.equal(payload.data.by, "real-user");
  assert.deepEqual(payload.data.input.values, { d1: 4, d2: 5 });
  assert.deepEqual(calls, ["resolve", "csrf", "submit"]);
  assert.equal((await handlers.submitPeerReview(json({ values: { d1: 1 }, idempotencyKey: "body" }, undefined, { "Idempotency-Key": "header" }), snapshot)).status, 400);
});

test("撤回与举报走各自路由，路由标识缺失/畸形直接 400", async () => {
  const { calls, handlers } = fixture();
  const withdrawn = await handlers.withdrawPeerReview(json({ expectedRevision: 3 }), snapshot);
  assert.equal(withdrawn.status, 200);
  assert.deepEqual(await withdrawn.json(), { data: { eventId: "A", snapshotId: "snap-1", input: { expectedRevision: 3 } }, requestId: "request-1" });
  const reported = await handlers.reportPeerReview(json({ reason: "与作品无关" }, "https://site.test/api/v1/competitions/A/works/snap-1/peer-review/epr-9/report"), { eventId: "A", snapshotId: "snap-1", reviewId: "epr-9" });
  assert.equal(reported.status, 200);
  assert.deepEqual(await reported.json(), { data: { eventId: "A", snapshotId: "snap-1", reviewId: "epr-9", input: { reason: "与作品无关" } }, requestId: "request-2" });
  assert.deepEqual(calls, ["resolve", "csrf", "withdraw", "resolve", "csrf", "report"]);
  assert.equal((await handlers.workPeerReview(new Request("https://site.test/x"), { eventId: "A" })).status, 400, "缺少作品标识");
  assert.equal((await handlers.reportPeerReview(json({}), { eventId: "A", snapshotId: "snap-1" })).status, 400, "缺少互评标识");
  assert.equal((await handlers.workPeerReview(new Request("https://site.test/x"), { eventId: "" })).status, 400, "缺少赛事标识");
});

test("压缩正文、超大正文与坏 JSON 都被安全拒绝，且不到达业务层", async () => {
  const { calls, handlers } = fixture();
  assert.equal((await handlers.submitPeerReview(new Request("https://site.test/x", { method: "POST", headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" }, body: "{}" }), snapshot)).status, 415);
  assert.equal((await handlers.submitPeerReview(json({ values: { d1: 4 }, idempotencyKey: "k", pad: "a".repeat(70000) }), snapshot)).status, 413);
  assert.equal((await handlers.submitPeerReview(new Request("https://site.test/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }), snapshot)).status, 400);
  assert.equal((await handlers.submitPeerReview(json([1, 2, 3]), snapshot)).status, 422);
  assert.equal(calls.filter(call => call === "submit").length, 0, "被拒请求不能到达业务层");
});
