import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../shared/errors.ts";
import type { OrganizerPrincipal } from "../../shared/organizer-contracts.ts";
import { createEventCommunityHandlers } from "./handlers.ts";
import type { EventCommunityService } from "./service.ts";

function fixture(authenticated = true, denyMutation = false) {
  const calls: string[] = []; let seq = 0;
  const principal: OrganizerPrincipal = { actor: { userId: "real-user", platformRoles: ["user"] }, guard: async () => {} };
  const service = {
    overview: async (p: OrganizerPrincipal, eventId: string) => { calls.push("overview"); return { eventId, by: p.actor.userId }; },
    requestConnection: async (p: OrganizerPrincipal, eventId: string, input: unknown) => { calls.push("request"); return { eventId, by: p.actor.userId, input }; },
    respondConnection: async (p: OrganizerPrincipal, eventId: string, connectionId: string, input: unknown) => { calls.push("respond"); return { eventId, connectionId, input }; },
    cancelConnection: async (p: OrganizerPrincipal, eventId: string, connectionId: string, input: unknown) => { calls.push("cancel"); return { eventId, connectionId, input }; },
    conversation: async (p: OrganizerPrincipal, eventId: string, peerUserId: string) => { calls.push("conversation"); return { eventId, peerUserId, by: p.actor.userId }; },
    sendDirectMessage: async (p: OrganizerPrincipal, eventId: string, input: unknown) => { calls.push("send"); return { eventId, by: p.actor.userId, input }; },
    withdrawDirectMessage: async (p: OrganizerPrincipal, eventId: string, messageId: string, input: unknown) => { calls.push("withdraw"); return { eventId, messageId, input }; },
    blockUser: async (p: OrganizerPrincipal, eventId: string, peerUserId: string) => { calls.push("block"); return { eventId, peerUserId }; },
    unblockUser: async (p: OrganizerPrincipal, eventId: string, peerUserId: string) => { calls.push("unblock"); return { eventId, peerUserId, removed: true }; },
    reportUser: async (p: OrganizerPrincipal, eventId: string, input: unknown) => { calls.push("report"); return { eventId, by: p.actor.userId, input }; },
    organizerReports: async (p: OrganizerPrincipal, eventId: string) => { calls.push("organizerReports"); return { eventId, by: p.actor.userId }; },
  } as unknown as EventCommunityService;
  return { calls, handlers: createEventCommunityHandlers({
    service,
    resolvePrincipal: async () => { calls.push("resolve"); return authenticated ? principal : null; },
    authorizeMutation: async () => { calls.push("csrf"); if (denyMutation) throw new DomainError("ORIGIN_REJECTED", "来源不符。", { status: 403 }); },
    requestIds: { next: () => `request-${++seq}` },
  }) };
}
const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://site.test/api/v1/competitions/A/community/messages", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const post = (path: string) => new Request(`https://site.test/api/v1${path}`, { method: "POST" });
const get = (path: string) => new Request(`https://site.test/api/v1${path}`);

test("读接口由真实 principal 解析；匿名 401、写请求授权失败 403 都在业务之前", async () => {
  const { calls, handlers } = fixture();
  const response = await handlers.overview(get("/competitions/A/community"), { eventId: "A" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { eventId: "A", by: "real-user" }, requestId: "request-1" });
  assert.deepEqual(calls, ["resolve", "overview"]);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);

  const anonymous = fixture(false);
  assert.equal((await anonymous.handlers.overview(get("/competitions/A/community"), { eventId: "A" })).status, 401);
  assert.deepEqual(anonymous.calls, ["resolve"]);

  const denied = fixture(true, true);
  assert.equal((await denied.handlers.sendDirectMessage(json({ peerUserId: "bob", content: "hi", idempotencyKey: "k" }), { eventId: "A" })).status, 403);
  assert.deepEqual(denied.calls, ["resolve", "csrf"]);
});

test("写入口使用真实 principal 与请求正文，不采信自称账号", async () => {
  const { calls, handlers } = fixture();
  const response = await handlers.sendDirectMessage(json({ actor: { userId: "other" }, peerUserId: "bob", content: "hi", idempotencyKey: "k" }), { eventId: "A" });
  assert.equal(response.status, 200);
  const payload = await response.json() as { data: { by: string; input: { peerUserId: string; content: string } } };
  assert.equal(payload.data.by, "real-user");
  assert.equal(payload.data.input.peerUserId, "bob");
  assert.equal(payload.data.input.content, "hi");
  assert.deepEqual(calls, ["resolve", "csrf", "send"]);
});

test("方法/压缩/超长/坏 JSON/非对象正文与缺少路由标识都被安全拒绝", async () => {
  const { calls, handlers } = fixture();
  assert.equal((await handlers.overview(post("/competitions/A/community"), { eventId: "A" })).status, 405);
  assert.equal((await handlers.sendDirectMessage(new Request("https://site.test/x", { method: "POST", headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" }, body: "{}" }), { eventId: "A" })).status, 415);
  assert.equal((await handlers.sendDirectMessage(json({ peerUserId: "bob", content: "hi", idempotencyKey: "k", pad: "a".repeat(70000) }), { eventId: "A" })).status, 413);
  assert.equal((await handlers.sendDirectMessage(new Request("https://site.test/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }), { eventId: "A" })).status, 400);
  assert.equal((await handlers.sendDirectMessage(json([1, 2, 3]), { eventId: "A" })).status, 422);
  assert.equal((await handlers.overview(get("/competitions/A/community"), { eventId: "" })).status, 400);
  assert.equal((await handlers.withdrawDirectMessage(json({ expectedRevision: 1 }), { eventId: "A" })).status, 400);
  assert.equal((await handlers.blockUser(json({}), { eventId: "A" })).status, 400);
  assert.equal(calls.filter(call => call === "send" || call === "withdraw" || call === "block").length, 0, "被拒请求不能到达业务层");
});

test("会话读取必须带对方账号；举报与屏蔽用路由标识与正文校验", async () => {
  const { calls, handlers } = fixture();
  const response = await handlers.conversation(get("/competitions/A/community/conversations/bob"), { eventId: "A", peerUserId: "bob" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { eventId: "A", peerUserId: "bob", by: "real-user" }, requestId: "request-1" });
  assert.equal((await handlers.conversation(get("/competitions/A/community/conversations"), { eventId: "A" })).status, 400);
  assert.equal((await handlers.respondConnection(json({ decision: "accept", expectedRevision: 1 }), { eventId: "A", connectionId: "c-1" })).status, 200);
  assert.equal((await handlers.respondConnection(json({ decision: "accept", expectedRevision: 1 }), { eventId: "A" })).status, 400);
  assert.equal((await handlers.reportUser(json({ peerUserId: "bob", reason: "spam", idempotencyKey: "k" }), { eventId: "A" })).status, 200);
  assert.equal((await handlers.unblockUser(json({ peerUserId: "bob" }), { eventId: "A" })).status, 200);
  assert.equal((await handlers.organizerReports(get("/organizer/events/A/community/reports"), { eventId: "A" })).status, 200);
  assert.ok(calls.includes("respond") && calls.includes("report") && calls.includes("unblock") && calls.includes("organizerReports"));
});
