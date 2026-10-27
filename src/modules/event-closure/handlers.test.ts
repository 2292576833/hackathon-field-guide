import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../shared/errors.ts";
import type { OrganizerPrincipal } from "../../shared/organizer-contracts.ts";
import { createEventClosureHandlers } from "./handlers.ts";
import type { EventClosureService } from "./service.ts";

function fixture(authenticated = true, denyMutation = false) {
  const calls: string[] = []; let seq = 0;
  const principal: OrganizerPrincipal = { actor: { userId: "real-user", platformRoles: ["user"] }, guard: async () => {} };
  const service = {
    postEventSummary: async (p: OrganizerPrincipal, eventId: string) => { calls.push("summary"); return { eventId, by: p.actor.userId }; },
    myContactWillingness: async (p: OrganizerPrincipal, eventId: string, teamId: string) => { calls.push("mine"); return { eventId, teamId, by: p.actor.userId }; },
    submitContactWillingness: async (p: OrganizerPrincipal, eventId: string, input: unknown) => { calls.push("submit"); return { eventId, by: p.actor.userId, input }; },
    withdrawContactWillingness: async (p: OrganizerPrincipal, eventId: string, id: string, input: unknown) => { calls.push("withdraw"); return { eventId, id, input }; },
  } as unknown as EventClosureService;
  return { calls, handlers: createEventClosureHandlers({
    service,
    resolvePrincipal: async () => { calls.push("resolve"); return authenticated ? principal : null; },
    authorizeMutation: async () => { calls.push("csrf"); if (denyMutation) throw new DomainError("ORIGIN_REJECTED", "来源不符。", { status: 403 }); },
    requestIds: { next: () => `request-${++seq}` },
  }) };
}
const json = (body: unknown, headers: Record<string, string> = {}) => new Request("https://site.test/api/v1/competitions/A/contact-willingness", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

test("读赛事闭环由真实 principal 解析，匿名与越权在业务之前被拦", async () => {
  const { calls, handlers } = fixture();
  const response = await handlers.postEventSummary(new Request("https://site.test/api/v1/organizer/events/A/closure"), { eventId: "A" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { eventId: "A", by: "real-user" }, requestId: "request-1" });
  assert.deepEqual(calls, ["resolve", "summary"]);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);

  const anonymous = fixture(false);
  assert.equal((await anonymous.handlers.postEventSummary(new Request("https://site.test/x"), { eventId: "A" })).status, 401);
  assert.deepEqual(anonymous.calls, ["resolve"]);

  const denied = fixture(true, true);
  assert.equal((await denied.handlers.submitContactWillingness(json({ teamId: "team-a", willing: true, idempotencyKey: "k" }), { eventId: "A" })).status, 403);
  assert.deepEqual(denied.calls, ["resolve", "csrf"]);
});

test("队伍侧写入口用真实 principal 与请求正文，不采信自称账号", async () => {
  const { calls, handlers } = fixture();
  const response = await handlers.submitContactWillingness(json({ actor: { userId: "other" }, teamId: "team-a", willing: true, idempotencyKey: "k" }), { eventId: "A" });
  assert.equal(response.status, 200);
  const payload = await response.json() as { data: { by: string; input: { teamId: string; willing: boolean } } };
  assert.equal(payload.data.by, "real-user");
  assert.equal(payload.data.input.teamId, "team-a");
  assert.equal(payload.data.input.willing, true);
  assert.equal((payload.data.input as unknown as Record<string, unknown>).idempotencyKey, "k");
  assert.deepEqual(calls, ["resolve", "csrf", "submit"]);
});

test("Idempotency-Key 头与正文不一致、方法错误、压缩正文、超长与坏 JSON 都被安全拒绝", async () => {
  const { calls, handlers } = fixture();
  assert.equal((await handlers.postEventSummary(new Request("https://site.test/x", { method: "POST" }), { eventId: "A" })).status, 405);
  assert.equal((await handlers.submitContactWillingness(json({ teamId: "team-a", willing: true, idempotencyKey: "body" }, { "Idempotency-Key": "header" }), { eventId: "A" })).status, 400);
  assert.equal((await handlers.submitContactWillingness(new Request("https://site.test/x", { method: "POST", headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" }, body: "{}" }), { eventId: "A" })).status, 415);
  assert.equal((await handlers.submitContactWillingness(json({ teamId: "team-a", willing: true, idempotencyKey: "k", pad: "a".repeat(70000) }), { eventId: "A" })).status, 413);
  assert.equal((await handlers.submitContactWillingness(new Request("https://site.test/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }), { eventId: "A" })).status, 400);
  assert.equal((await handlers.submitContactWillingness(json([1, 2, 3]), { eventId: "A" })).status, 422);
  assert.equal(calls.filter(call => call === "submit").length, 0, "被拒请求不能到达业务层");
});

test("队伍侧读取需要 teamId，缺少路由标识直接拒绝", async () => {
  const { handlers } = fixture();
  const response = await handlers.myContactWillingness(new Request("https://site.test/api/v1/competitions/A/contact-willingness?teamId=team-a"), { eventId: "A" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { eventId: "A", teamId: "team-a", by: "real-user" }, requestId: "request-1" });
  assert.equal((await handlers.myContactWillingness(new Request("https://site.test/x"), { eventId: "A" })).status, 400);
  assert.equal((await handlers.postEventSummary(new Request("https://site.test/x"), { eventId: "" })).status, 400);
  assert.equal((await handlers.withdrawContactWillingness(json({ expectedRevision: 1 }), { eventId: "A" })).status, 400);
});
