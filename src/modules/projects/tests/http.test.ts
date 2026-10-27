import assert from "node:assert/strict";
import test from "node:test";
import type { Actor } from "../../../shared/contracts.ts";
import { DomainError } from "../../../shared/errors.ts";
import { createProjectsHttpHandlers } from "../handlers.ts";
import { ProjectsService } from "../service.ts";
import { createInvitationTokens } from "../tokens.ts";
import { instantField, referenceUrl } from "../validation.ts";

const actor: Actor = { userId: "trusted_session_user", platformRoles: ["user"] };

function fakeService(overrides: Partial<ProjectsService> = {}): ProjectsService {
  return { listProjects: async () => [], ...overrides } as ProjectsService;
}

function handler(service: ProjectsService, guard: () => Promise<void> = async () => {}) {
  return createProjectsHttpHandlers({ service, resolveActor: async () => actor, authorizeMutation: guard, requestId: () => "request_1" });
}

test("HTTP uses verified session actor, applies mutation guard and disables caching of invitation tokens", async () => {
  let guards = 0; let receivedActor: Actor | undefined;
  const api = handler(fakeService({ createProjectInvitation: async (verifiedActor) => {
    receivedActor = verifiedActor;
    return { token: "one_time_secret", invitation: {} as never, projectRevision: 2 };
  } }), async () => { guards += 1; });
  const response = await api.handle(new Request("https://app.example/api/v1/projects/p/invitations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: 1, role: "member" }) }), { kind: "projectInvitations", projectId: "p" });
  assert.equal(response.status, 201); assert.equal(guards, 1); assert.equal(receivedActor, actor);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
});

test("anonymous requests and rejected mutation guards never call the service", async () => {
  let calls = 0;
  const service = fakeService({ createProject: async () => { calls += 1; return {} as never; } });
  const request = () => new Request("https://app.example/api/v1/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const anonymous = createProjectsHttpHandlers({ service, resolveActor: async () => null, authorizeMutation: async () => {}, requestId: () => "req" });
  assert.equal((await anonymous.handle(request(), { kind: "projects" })).status, 401);
  const guarded = handler(service, async () => { throw new DomainError("CSRF_REJECTED", "请刷新页面后重试。", { status: 403 }); });
  assert.equal((await guarded.handle(request(), { kind: "projects" })).status, 403);
  assert.equal(calls, 0);
});

test("GET invitation links cannot join a project", async () => {
  let calls = 0;
  const api = handler(fakeService({ acceptInvitation: async () => { calls += 1; return {} as never; } }));
  const response = await api.handle(new Request("https://app.example/join/token"), { kind: "invitationAccept", token: "secret" });
  assert.equal(response.status, 405); assert.equal(response.headers.get("Allow"), "POST"); assert.equal(calls, 0);
});

test("HTTP rejects malformed JSON, wrong content type and streaming oversized bodies before domain mutation", async () => {
  let calls = 0;
  const api = handler(fakeService({ createProject: async () => { calls += 1; return {} as never; } }));
  const wrong = await api.handle(new Request("https://app.example/api", { method: "POST", body: "{}" }), { kind: "projects" });
  assert.equal(wrong.status, 415);
  const malformed = await api.handle(new Request("https://app.example/api", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }), { kind: "projects" });
  assert.equal(malformed.status, 422);
  const oversized = await api.handle(new Request("https://app.example/api", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "x".repeat(65 * 1024) }) }), { kind: "projects" });
  assert.equal(oversized.status, 413); assert.equal(calls, 0);
});

test("unknown provider exceptions do not disclose messages or stacks", async () => {
  const api = handler(fakeService({ listProjects: async () => { throw new Error("database-password=private"); } }));
  const response = await api.handle(new Request("https://app.example/api"), { kind: "projects" });
  const text = await response.text();
  assert.equal(response.status, 500); assert.ok(!text.includes("database-password")); assert.ok(text.includes("INTERNAL_ERROR"));
});

test("oversized body responds even when transport cancellation never settles", async () => {
  let calls = 0;
  const api = handler(fakeService({ createProject: async () => { calls += 1; return {} as never; } }));
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(65537)); },
    cancel() { return new Promise<void>(() => {}); },
  });
  const request = new Request("https://app.example/api", { method: "POST", headers: { "Content-Type": "application/json" }, body, duplex: "half" } as RequestInit);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([api.handle(request, { kind: "projects" }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("handler waited for cancellation")), 250); })]);
    assert.equal(response.status, 413); assert.equal(calls, 0);
  } finally { clearTimeout(timer); }
});

test("invitation tokens use random capability and digest; malformed tokens are unavailable", () => {
  const tokens = createInvitationTokens();
  const first = tokens.issue(); const second = tokens.issue();
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/); assert.match(first.tokenHash, /^[a-f0-9]{64}$/);
  assert.equal(tokens.hash(first.token), first.tokenHash); assert.notEqual(first.token, second.token);
  assert.throws(() => tokens.hash("guess"), (error) => error instanceof DomainError && error.status === 404);
});

test("URL and date validation rejects executable links, URL credentials, missing timezone and normalized invalid dates", () => {
  for (const url of ["javascript:alert(1)", "data:text/html,secret", "https://name:password@example.com/path"]) assert.throws(() => referenceUrl(url), DomainError);
  for (const date of ["2026-10-08T12:00:00", "2026-02-30T12:00:00Z", "2026-10-08T24:00:00Z"]) assert.throws(() => instantField(date, "时间"), DomainError);
  assert.equal(instantField("2026-10-08T12:00:00+08:00", "时间"), "2026-10-08T04:00:00.000Z");
});
