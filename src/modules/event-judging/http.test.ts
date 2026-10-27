import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../shared/errors.ts";
import { createEventJudgingHandlers } from "./http.ts";
import type { EventJudgingService } from "./service.ts";
import type { OrganizerPrincipal } from "../../shared/organizer-contracts.ts";

function fixture(authenticated = true, denyMutation = false) {
  const calls: string[] = []; let seq = 0;
  const principal: OrganizerPrincipal = { actor: { userId: "real-user", platformRoles: ["user"] }, guard: async () => {} };
  const service = { previewSubmission: async (p: OrganizerPrincipal, eventId: string, input: unknown) => { calls.push("preview"); return { user: p.actor.userId, eventId, input }; }, publicResults: async (eventId: string) => { calls.push("public"); return { eventId, rows: [] }; },
    works: async (_p: OrganizerPrincipal, eventId: string) => { calls.push("works"); return { eventId, items: [], visibleCount: 0 }; },
    publicWorks: async (eventId: string) => { calls.push("publicWorks"); return { eventId, items: [], visibleCount: 0 }; },
    myWorkDisclosure: async (_p: OrganizerPrincipal, eventId: string, teamId: string) => { calls.push("myWorkDisclosure"); return { eventId, teamId, active: null }; },
    eventWorkShowcase: async (_p: OrganizerPrincipal, eventId: string) => { calls.push("eventWorkShowcase"); return { eventId, items: [], visibleCount: 0 }; },
    submitWorkDisclosure: async (_p: OrganizerPrincipal, eventId: string, teamId: string, input: { idempotencyKey: string }) => { calls.push("submitWorkDisclosure"); return { eventId, teamId, key: input.idempotencyKey }; },
    withdrawWorkDisclosure: async (_p: OrganizerPrincipal, eventId: string, teamId: string, input: { expectedRevision: number }) => { calls.push("withdrawWorkDisclosure"); return { eventId, teamId, revision: input.expectedRevision }; },
    workComments: async (_p: OrganizerPrincipal, eventId: string, snapshotId: string) => { calls.push("workComments"); return { eventId, snapshotId, items: [] }; },
    createWorkComment: async (_p: OrganizerPrincipal, eventId: string, snapshotId: string, input: { idempotencyKey: string }) => { calls.push("createWorkComment"); return { eventId, snapshotId, key: input.idempotencyKey }; },
    hideWorkComment: async (_p: OrganizerPrincipal, eventId: string, snapshotId: string, commentId: string, input: { reason?: string }) => { calls.push("hideWorkComment"); return { eventId, snapshotId, commentId, reason: input.reason ?? "" }; },
    reportWorkComment: async (_p: OrganizerPrincipal, eventId: string, snapshotId: string, commentId: string, input: { reason?: string }) => { calls.push("reportWorkComment"); return { eventId, snapshotId, commentId, reason: input.reason ?? "" }; } } as unknown as EventJudgingService;
  return { calls, handlers: createEventJudgingHandlers({ service, resolvePrincipal: async () => { calls.push("resolve"); return authenticated ? principal : null; }, authorizeMutation: async () => { calls.push("csrf"); if (denyMutation) throw new DomainError("ORIGIN_REJECTED", "来源不符。", { status: 403 }); }, requestIds: { next: () => `request-${++seq}` } }) };
}
const request = (body: unknown) => new Request("https://site.test/api/v1/competitions/A/submissions/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
test("HTTP resolves trusted principal, performs mutation authorization and ignores claimed actor for authentication", async () => {
  const { calls, handlers } = fixture(); const response = await handlers.previewSubmission(request({ actor: { userId: "other" }, teamId: "team" }), { eventId: "A" });
  assert.equal(response.status, 200); const json = await response.json(); assert.equal(json.data.user, "real-user"); assert.deepEqual(calls, ["resolve", "csrf", "preview"]); assert.match(response.headers.get("cache-control")!, /no-store/);
});
test("unauthenticated and rejected origins never reach business mutation", async () => {
  const anonymous = fixture(false); assert.equal((await anonymous.handlers.previewSubmission(request({}), { eventId: "A" })).status, 401); assert.deepEqual(anonymous.calls, ["resolve"]);
  const denied = fixture(true, true); assert.equal((await denied.handlers.previewSubmission(request({}), { eventId: "A" })).status, 403); assert.deepEqual(denied.calls, ["resolve", "csrf"]);
});
test("wrong methods, compressed JSON and oversized streams are rejected with safe envelopes", async () => {
  const { handlers, calls } = fixture();
  assert.equal((await handlers.previewSubmission(new Request("https://site.test", { method: "GET" }), { eventId: "A" })).status, 405);
  assert.equal(calls.length, 0);
  assert.equal((await handlers.previewSubmission(new Request("https://site.test", { method: "POST", headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" }, body: "{}" }), { eventId: "A" })).status, 415);
  const response = await handlers.previewSubmission(request({ description: "a".repeat(70000) }), { eventId: "A" }); assert.equal(response.status, 413); assert.equal(calls.includes("preview"), false);
  const malformed = await handlers.previewSubmission(new Request("https://site.test", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }), { eventId: "A" }); assert.equal(malformed.status, 400);
});

test("works handlers resolve route parameters and enforce the idempotency key contract", async () => {
  const { calls, handlers } = fixture(true);
  const list = await handlers.works(new Request("https://site.test/api/v1/competitions/A/works"), { eventId: "A" });
  assert.equal(list.status, 200); assert.equal((await list.json()).data.eventId, "A"); assert.match(list.headers.get("cache-control")!, /no-store/);
  const view = await handlers.myWorkDisclosure(new Request("https://site.test/api/v1/competitions/A/works/team-a/disclosure"), { eventId: "A", teamId: "team-a" });
  assert.equal(view.status, 200); assert.deepEqual((await view.json()).data, { eventId: "A", teamId: "team-a", active: null });
  // 缺少队伍参数必须在进入业务逻辑之前被拒绝。
  assert.equal((await handlers.myWorkDisclosure(new Request("https://site.test/x"), { eventId: "A" })).status, 400);
  const json = (body: unknown, key?: string) => new Request("https://site.test/x", { method: "POST", headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) }, body: JSON.stringify(body) });
  const posted = await handlers.submitWorkDisclosure(json({ scope: "public", fields: { title: true } }, "k-1"), { eventId: "A", teamId: "team-a" });
  assert.equal(posted.status, 200); assert.deepEqual((await posted.json()).data, { eventId: "A", teamId: "team-a", key: "k-1" });
  // 请求头与正文的重试标识不一致必须拒绝，且不能到达服务层。
  const mismatch = await handlers.submitWorkDisclosure(json({ scope: "public", idempotencyKey: "k-2" }, "k-1"), { eventId: "A", teamId: "team-a" });
  assert.equal(mismatch.status, 400); assert.equal(calls.filter(call => call === "submitWorkDisclosure").length, 1);
  assert.equal((await handlers.withdrawWorkDisclosure(json({ expectedRevision: 1 }), { eventId: "A", teamId: "team-a" })).status, 200);
  assert.equal((await handlers.eventWorkShowcase(new Request("https://site.test/x"), { eventId: "A" })).status, 200);
});
test("disclosure mutation without mutation authorization never reaches the service", async () => {
  const { calls, handlers } = fixture(true, true);
  const response = await handlers.submitWorkDisclosure(new Request("https://site.test/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope: "public" }) }), { eventId: "A", teamId: "team-a" });
  assert.equal(response.status, 403); assert.deepEqual(calls, ["resolve", "csrf"]);
});
const commentJson = (body: unknown, key?: string) => new Request("https://site.test/x", { method: "POST", headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) }, body: JSON.stringify(body) });

test("文字留言路由：解析作品与留言参数、复用重试标识契约，并要求已登录", async () => {
  const { calls, handlers } = fixture(true);
  const list = await handlers.workComments(new Request("https://site.test/api/v1/competitions/A/works/snap-1/comments"), { eventId: "A", snapshotId: "snap-1" });
  assert.equal(list.status, 200); assert.deepEqual((await list.json()).data, { eventId: "A", snapshotId: "snap-1", items: [] });
  assert.match(list.headers.get("cache-control")!, /no-store/);
  // 缺少作品参数必须在进入业务逻辑之前被拒绝。
  assert.equal((await handlers.workComments(new Request("https://site.test/x"), { eventId: "A" })).status, 400);
  const posted = await handlers.createWorkComment(commentJson({ text: "留言" }, "k-1"), { eventId: "A", snapshotId: "snap-1" });
  assert.equal(posted.status, 200); assert.deepEqual((await posted.json()).data, { eventId: "A", snapshotId: "snap-1", key: "k-1" });
  // 请求头与正文的重试标识不一致必须拒绝，且不能到达服务层。
  const mismatch = await handlers.createWorkComment(commentJson({ text: "留言", idempotencyKey: "k-2" }, "k-1"), { eventId: "A", snapshotId: "snap-1" });
  assert.equal(mismatch.status, 400); assert.equal(calls.filter(call => call === "createWorkComment").length, 1);
  // 隐藏与举报必须同时给出作品与留言参数。
  assert.equal((await handlers.hideWorkComment(commentJson({ reason: "本人撤回" }), { eventId: "A", snapshotId: "snap-1", commentId: "cm-1" })).status, 200);
  assert.equal((await handlers.hideWorkComment(commentJson({}), { eventId: "A", snapshotId: "snap-1" })).status, 400);
  assert.equal((await handlers.reportWorkComment(commentJson({ reason: "与作品无关" }), { eventId: "A", snapshotId: "snap-1", commentId: "cm-1" })).status, 200);
  assert.equal((await handlers.reportWorkComment(commentJson({}), { eventId: "A", snapshotId: "snap-1" })).status, 400);
  // 错误方法不进服务层。
  assert.equal((await handlers.createWorkComment(new Request("https://site.test/x"), { eventId: "A", snapshotId: "snap-1" })).status, 405);
  // 未登录 401：公开档的留言也要求已登录，因此不会调用任何留言服务。
  const anonymous = fixture(false);
  assert.equal((await anonymous.handlers.workComments(new Request("https://site.test/x"), { eventId: "A", snapshotId: "snap-1" })).status, 401);
  assert.deepEqual(anonymous.calls, ["resolve"]);
});

test("文字留言写入必须通过 mutation 授权，读取不需要；被拒写入不产生任何留言事实", async () => {
  const { calls, handlers } = fixture(true, true);
  const denied = await handlers.createWorkComment(commentJson({ text: "越权留言" }), { eventId: "A", snapshotId: "snap-1" });
  assert.equal(denied.status, 403); assert.deepEqual(calls, ["resolve", "csrf"]);
  assert.equal((await handlers.hideWorkComment(commentJson({}), { eventId: "A", snapshotId: "snap-1", commentId: "cm-1" })).status, 403);
  assert.equal((await handlers.reportWorkComment(commentJson({}), { eventId: "A", snapshotId: "snap-1", commentId: "cm-1" })).status, 403);
  const read = await handlers.workComments(new Request("https://site.test/x"), { eventId: "A", snapshotId: "snap-1" });
  assert.equal(read.status, 200, "读取是 GET，不需要 mutation 授权");
  assert.deepEqual(calls, ["resolve", "csrf", "resolve", "csrf", "resolve", "csrf", "resolve", "workComments"]);
});

test("public works handler exposes only the public projection and does not resolve a private identity", async () => {
  const { calls, handlers } = fixture(false);
  const response = await handlers.publicWorks(new Request("https://site.test/api/v1/competitions/A/works"), { eventId: "A" });
  assert.equal(response.status, 200); assert.deepEqual(calls, ["publicWorks"]); assert.equal(response.headers.get("cache-control"), "no-store");
});
test("public result handler exposes only explicit public service projection and does not resolve private identity", async () => {
  const { calls, handlers } = fixture(false); const response = await handlers.publicResults(new Request("https://site.test/results"), { eventId: "A" });
  assert.equal(response.status, 200); assert.deepEqual(calls, ["public"]); assert.equal(response.headers.get("cache-control"), "no-store");
});
