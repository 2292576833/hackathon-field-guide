import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { HostedEventScope, OrganizerPrincipal } from "../../shared/organizer-contracts.ts";
import type { EventSitePublicEvent } from "./service.ts";
import { createEventSiteService, type EventSiteAccessPort, type EventSiteAuditEvent } from "./service.ts";
import { createEventSiteHandlers, EVENT_SITE_JSON_BODY_LIMIT, EVENT_SITE_SPEC_BODY_LIMIT } from "./handlers.ts";

/**
 * HTTP 工厂验证：只测 HTTP 层该负责的事——方法、登录、写授权顺序、body 解析与体积上限、
 * DomainError → 错误信封、私有 no-store / nosniff 响应头，以及公开入口不需要登录。
 * 权限矩阵与状态机在 service.test.ts 里测；这里跑的是真服务（真 SQL + 真端口），不是假对象。
 */
let engine: PGlite;
let database: DatabasePort;

function executor(connection: Pick<PGlite, "query">): SqlExecutor {
  return {
    async query<Row>(statement: string, parameters: readonly unknown[] = []) {
      const result = await connection.query<Row>(statement, [...parameters]);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
}

before(async () => {
  engine = new PGlite();
  await engine.exec([
    "CREATE TABLE auth_users(id text PRIMARY KEY);",
    "CREATE TABLE organizer_organizations(id text PRIMARY KEY);",
    "CREATE TABLE organizer_hosted_events(id text PRIMARY KEY, organization_id text NOT NULL, UNIQUE(id, organization_id));",
    "INSERT INTO auth_users(id) VALUES ('manager'),('admin'),('org-admin');",
    "INSERT INTO organizer_organizations(id) VALUES ('org-a');",
  ].join("\n"));
  await engine.exec(await readFile(new URL("../../../migrations/080_event_site.sql", import.meta.url), "utf8"));
  database = { ...executor(engine), transaction: work => engine.transaction(transaction => work(executor(transaction))) };
});

after(async () => {
  await engine.close();
});

const AT = "2026-10-18T04:00:00.000Z";
const BASE = "https://field-guide.example";
let eventCounter = 0;
let idCounter = 0;

interface Setup {
  readonly handlers: ReturnType<typeof createEventSiteHandlers>;
  readonly eventId: string;
  readonly audit: EventSiteAuditEvent[];
  readonly mutations: { count: number; fail: boolean };
  readonly signedOut: { value: boolean };
  readonly principalResolutions: { count: number };
}

async function setup(): Promise<Setup> {
  eventCounter += 1;
  const eventId = "event-" + String(eventCounter);
  await database.query("INSERT INTO organizer_hosted_events(id,organization_id) VALUES($1,'org-a')", [eventId]);
  const event: EventSitePublicEvent = { eventId, organizationId: "org-a", title: "赛事 " + String(eventCounter), status: "published" };

  const principal: OrganizerPrincipal = {
    actor: { userId: "manager", platformRoles: [] },
    guard: async () => undefined,
  };
  const access: EventSiteAccessPort = {
    async requireEventManager(_sql, actor, id): Promise<HostedEventScope> {
      if (actor.actor.userId !== "manager" || id !== eventId) {
        throw new DomainError("ORGANIZER_FORBIDDEN", "你目前没有这场比赛的操作权限。", { status: 403 });
      }
      const scope: HostedEventScope = {
        organizationId: "org-a", organizationName: "机构", eventId, title: event.title, status: "published",
        revision: 1, publishedRevision: 1, timezone: "Asia/Shanghai", startsAt: AT, endsAt: AT,
        registrationOpensAt: null, registrationClosesAt: null, submissionClosesAt: null,
        modules: { registration: true, teams: true, judging: true, schedule: true, accommodation: false, mealVouchers: false, icebreaking: false },
        registration: { reviewRequired: false, capacity: null },
        teams: { mode: "free", minSize: 1, maxSize: 4, locksAt: null }, linkedEventId: null,
      };
      return scope;
    },
    async requireOrganizationAdmin(_sql, actor, organizationId): Promise<void> {
      if (actor.actor.userId !== "org-admin" || organizationId !== "org-a") {
        throw new DomainError("ORGANIZER_FORBIDDEN", "只有机构管理员可以管理模板。", { status: 403 });
      }
    },
    async requirePlatformAdmin(_sql, actor): Promise<void> {
      if (actor.actor.userId !== "admin") throw new DomainError("ORGANIZER_FORBIDDEN", "只有平台管理员可以执行。", { status: 403 });
    },
    async publicEvent(_sql, id): Promise<EventSitePublicEvent | null> {
      return id === eventId ? event : null;
    },
  };
  const audit: EventSiteAuditEvent[] = [];
  const admin: OrganizerPrincipal = { actor: { userId: "admin", platformRoles: ["admin"] }, guard: async () => undefined };
  const orgAdmin: OrganizerPrincipal = { actor: { userId: "org-admin", platformRoles: [] }, guard: async () => undefined };

  const service = createEventSiteService({
    database, clock: { now: () => new Date(AT) }, ids: { next: () => "id-" + String(++idCounter) },
    access,
    audit: { async record(_sql, item) { audit.push(item); } },
    facts: {
      async schedule() {
        return { registrationCloses: "2026-10-20T16:00:00.000Z", submissionCloses: null, startsAt: null, endsAt: null, timezone: "Asia/Shanghai" };
      },
      async scheduleNodes() { return []; },
      async faqEntries() { return []; },
    },
    shortCodes: { next: () => "CODE" + String(++idCounter).padStart(12, "0") },
  });

  const mutations = { count: 0, fail: false };
  const signedOut = { value: false };
  const principalResolutions = { count: 0 };
  const handlers = createEventSiteHandlers({
    service,
    async resolvePrincipal(request) {
      principalResolutions.count += 1;
      if (signedOut.value) return null;
      const who = request.headers.get("x-test-user");
      if (who === "admin") return admin;
      if (who === "org-admin") return orgAdmin;
      return principal;
    },
    async authorizeMutation(request) {
      mutations.count += 1;
      if (mutations.fail) throw new DomainError("ORIGIN_REJECTED", "请求来源无效。", { status: 403 });
      if (request.headers.get("origin") !== BASE) throw new DomainError("ORIGIN_REJECTED", "请求来源无效。", { status: 403 });
    },
    requestIds: { next: () => "event-site-http-" + String(idCounter) },
  });
  return { handlers, eventId, audit, mutations, signedOut, principalResolutions };
}

function request(method: string, path: string, options: { body?: string; contentType?: string | null; user?: string; origin?: string | null; length?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (options.user !== undefined) headers["x-test-user"] = options.user;
  if (options.contentType !== null) headers["content-type"] = options.contentType ?? "application/json";
  if (options.origin !== null) headers["origin"] = options.origin ?? BASE;
  if (options.length !== undefined) headers["content-length"] = options.length;
  return new Request(BASE + path, {
    method,
    headers,
    ...(method === "GET" || method === "DELETE" ? {} : { body: options.body ?? "{}" }),
  });
}

const emptySpec = { version: 1, blocks: [] };

/* ------------------------------------------------------------------ *
 * 形状：入口齐全、错误信封与响应头
 * ------------------------------------------------------------------ */

test("15 个入口都在，且公开入口不解析登录身份", async () => {
  const f = await setup();
  for (const name of [
    "publicPage", "getPage", "savePage", "publishPage", "rotateShortCode", "suspendPage", "resumePage",
    "listTemplates", "saveTemplate", "listOrganizationPages", "applyTemplate", "deleteTemplate",
    "listHostedSites", "adminSuspendPage", "adminResumePage",
  ]) {
    assert.equal(typeof (f.handlers as unknown as Record<string, unknown>)[name], "function", name);
  }
  // 公开页：不登录也能拿，且**不**去解析身份（解析器会记数）。
  const saved = await f.handlers.savePage(request("PUT", "/page", { body: JSON.stringify({ spec: emptySpec, expectedRevision: 0 }) }), { eventId: f.eventId });
  assert.equal(saved.status, 200);
  const code = (await saved.json()).data.shortCode as string;
  await f.handlers.publishPage(request("POST", "/page/publish", { body: JSON.stringify({ expectedRevision: 1 }) }), { eventId: f.eventId });
  const before = f.principalResolutions.count;
  const publicResponse = await f.handlers.publicPage(request("GET", "/s/" + code, { user: "" }), { shortCode: code });
  assert.equal(publicResponse.status, 200);
  assert.equal(f.principalResolutions.count, before, "公开入口不得解析身份");
});

test("未登录 401、方法不符 405，错误信封带 requestId 与私有响应头", async () => {
  const f = await setup();
  f.signedOut.value = true;
  const unauthorized = await f.handlers.getPage(request("GET", "/page"), { eventId: f.eventId });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get("cache-control"), "private, no-store");
  assert.equal(unauthorized.headers.get("x-content-type-options"), "nosniff");
  const body = await unauthorized.json();
  assert.equal(body.error.code, "UNAUTHENTICATED");
  assert.equal(typeof body.requestId, "string");
  assert.equal(body.error.message.includes("login"), false);

  f.signedOut.value = false;
  const wrongMethod = await f.handlers.publishPage(request("DELETE", "/page/publish"), { eventId: f.eventId });
  assert.equal(wrongMethod.status, 405);
  assert.equal((await wrongMethod.json()).error.code, "METHOD_NOT_ALLOWED");
  assert.equal(f.mutations.count, 0, "方法不符不该走到写授权");
});

test("路由参数缺失 400；公开入口的短码无效也是 400 而不是 500", async () => {
  const f = await setup();
  const missing = await f.handlers.getPage(request("GET", "/page"), {});
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.code, "INVALID_ROUTE");
  const badCode = await f.handlers.publicPage(request("GET", "/s/"), {});
  assert.equal(badCode.status, 400);
});

/* ------------------------------------------------------------------ *
 * 写授权顺序
 * ------------------------------------------------------------------ */

test("写请求先过 authorizeMutation：拒了就 403，且什么都没写", async () => {
  const f = await setup();
  f.mutations.fail = true;
  const rejected = await f.handlers.savePage(request("PUT", "/page", {
    body: JSON.stringify({ spec: emptySpec, expectedRevision: 0 }), origin: "https://evil.example",
  }), { eventId: f.eventId });
  assert.equal(rejected.status, 403);
  assert.equal((await rejected.json()).error.code, "ORIGIN_REJECTED");
  assert.equal(f.mutations.count, 1, "写请求必须先过写授权");
  const rows = await database.query("SELECT 1 FROM organizer_page_specs WHERE event_id=$1", [f.eventId]);
  assert.equal(rows.rowCount, 0);

  f.mutations.fail = false;
  const created = await f.handlers.savePage(request("PUT", "/page", { body: JSON.stringify({ spec: emptySpec, expectedRevision: 0 }) }), { eventId: f.eventId });
  assert.equal(created.status, 200);
  const before = f.mutations.count;
  const read = await f.handlers.getPage(request("GET", "/page"), { eventId: f.eventId });
  assert.equal(read.status, 200);
  assert.equal(f.mutations.count, before, "只读请求不做写授权");
});

/* ------------------------------------------------------------------ *
 * body 解析与体积
 * ------------------------------------------------------------------ */

test("body：非 JSON 415、坏 JSON 400、数组 422、声明超限 413", async () => {
  const f = await setup();
  const notJson = await f.handlers.savePage(request("PUT", "/page", { contentType: "text/plain", body: "spec={}" }), { eventId: f.eventId });
  assert.equal(notJson.status, 415);
  assert.equal((await notJson.json()).error.code, "JSON_REQUIRED");

  const broken = await f.handlers.savePage(request("PUT", "/page", { body: "{not json" }), { eventId: f.eventId });
  assert.equal(broken.status, 400);
  assert.equal((await broken.json()).error.code, "INVALID_JSON");

  const array = await f.handlers.savePage(request("PUT", "/page", { body: "[]" }), { eventId: f.eventId });
  assert.equal(array.status, 422);
  assert.equal((await array.json()).error.code, "EVENT_SITE_INVALID_INPUT");

  // 真发一段超过上限的字节流：边读边计数，超限立刻停，不把大包读进内存。
  const huge = await f.handlers.publishPage(request("POST", "/page/publish", {
    body: "x".repeat(EVENT_SITE_JSON_BODY_LIMIT + 1),
  }), { eventId: f.eventId });
  assert.equal(huge.status, 413);
  assert.equal((await huge.json()).error.code, "PAYLOAD_TOO_LARGE");

  // 规格入口的上限更宽（160KB），但也要挡住更大的包。
  const oversizedSpec = await f.handlers.savePage(request("PUT", "/page", {
    body: "x".repeat(EVENT_SITE_SPEC_BODY_LIMIT + 1),
  }), { eventId: f.eventId });
  assert.equal(oversizedSpec.status, 413);
  assert.equal((await oversizedSpec.json()).error.code, "PAYLOAD_TOO_LARGE");
});

test("规格类写请求放行到 128KB 的边界，超过规格上限是 EVENT_SITE_SPEC_TOO_LARGE", async () => {
  const f = await setup();
  // 135KB 的正文：既超过 128KB 规格上限，又在 160KB 请求上限之内——体积判断必须是规格那条规则。
  const text = "字".repeat(45000);
  const response = await f.handlers.savePage(request("PUT", "/page", {
    body: JSON.stringify({ spec: { version: 1, blocks: [{ kind: "richText", id: "r1", variant: "prose", priority: 3, collapse: false, text }] }, expectedRevision: 0 }),
  }), { eventId: f.eventId });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, "EVENT_SITE_SPEC_TOO_LARGE");
  assert.ok(EVENT_SITE_SPEC_BODY_LIMIT > EVENT_SITE_JSON_BODY_LIMIT);
});

/* ------------------------------------------------------------------ *
 * 业务错误的信封
 * ------------------------------------------------------------------ */

test("业务错误走同一个信封：缺版本号 422、发布闸门 422、CAS 冲突 409 带 latestRevision", async () => {
  const f = await setup();
  const missingRevision = await f.handlers.savePage(request("PUT", "/page", { body: JSON.stringify({ spec: emptySpec }) }), { eventId: f.eventId });
  assert.equal(missingRevision.status, 422);
  assert.equal((await missingRevision.json()).error.code, "EVENT_SITE_INVALID_REVISION");

  await f.handlers.savePage(request("PUT", "/page", { body: JSON.stringify({ spec: emptySpec, expectedRevision: 0 }) }), { eventId: f.eventId });
  const conflict = await f.handlers.savePage(request("PUT", "/page", { body: JSON.stringify({ spec: emptySpec, expectedRevision: 0 }) }), { eventId: f.eventId });
  assert.equal(conflict.status, 409);
  const conflictBody = await conflict.json();
  assert.equal(conflictBody.error.code, "EVENT_SITE_REVISION_CONFLICT");
  assert.equal(conflictBody.error.latestRevision, 1);
  assert.equal(conflictBody.error.recoveryAction, "reload");

  await database.query("UPDATE organizer_page_specs SET draft=$1::jsonb WHERE event_id=$2", [
    JSON.stringify({ version: 1, blocks: [{ kind: "videoEmbed", id: "v1", variant: "x", priority: 3, collapse: false }] }), f.eventId,
  ]);
  const gated = await f.handlers.publishPage(request("POST", "/page/publish", { body: JSON.stringify({ expectedRevision: 1 }) }), { eventId: f.eventId });
  assert.equal(gated.status, 422);
  assert.equal((await gated.json()).error.code, "EVENT_SITE_UNKNOWN_BLOCK_KIND");
});

/* ------------------------------------------------------------------ *
 * 公开页与停用
 * ------------------------------------------------------------------ */

test("公开页：已发布 200 带事实绑定值；停用后 404；短码不存在 404", async () => {
  const f = await setup();
  const boundSpec = { version: 1, blocks: [{ kind: "countdown", id: "c1", variant: "compact", priority: 3, collapse: false, heading: null, text: null, items: [], image: null, binding: { source: "eventSchedule", field: "registrationCloses" } }] };
  const saved = await f.handlers.savePage(request("PUT", "/page", { body: JSON.stringify({ spec: boundSpec, expectedRevision: 0 }) }), { eventId: f.eventId });
  const savedBody = (await saved.json()).data;
  const published = await f.handlers.publishPage(request("POST", "/page/publish", { body: JSON.stringify({ expectedRevision: 1 }) }), { eventId: f.eventId });
  assert.equal(published.status, 200);
  const publishedBody = (await published.json()).data;
  const code = savedBody.shortCode as string;
  assert.equal(publishedBody.publishedRevision, 1);

  const publicResponse = await f.handlers.publicPage(request("GET", "/s/x"), { shortCode: code });
  assert.equal(publicResponse.status, 200);
  const view = (await publicResponse.json()).data;
  assert.equal(view.eventId, f.eventId);
  assert.deepEqual(view.spec, boundSpec);
  assert.equal(view.factsState, "read");
  assert.equal(view.facts.registrationCloses, "2026-10-20T16:00:00.000Z");

  const suspended = await f.handlers.suspendPage(request("POST", "/page/suspend", {
    body: JSON.stringify({ expectedRevision: 2, kind: "organizer", reason: "临时下线" }),
  }), { eventId: f.eventId });
  assert.equal(suspended.status, 200);
  const gone = await f.handlers.publicPage(request("GET", "/s/x"), { shortCode: code });
  assert.equal(gone.status, 404);
  assert.equal((await gone.json()).error.code, "EVENT_SITE_PAGE_NOT_FOUND");
  assert.equal((await f.handlers.publicPage(request("GET", "/s/x"), { shortCode: "ZZZZZZZZZZZZZZZZ" })).status, 404);
});

/* ------------------------------------------------------------------ *
 * 模板与平台入口
 * ------------------------------------------------------------------ */

test("模板入口：DELETE 允许不带 body；模板写要机构管理员；平台入口固定平台级别", async () => {
  const f = await setup();
  const denied = await f.handlers.saveTemplate(request("POST", "/templates?organizationId=org-a", {
    user: "manager", body: JSON.stringify({ name: "门面", spec: emptySpec }),
  }), {});
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, "ORGANIZER_FORBIDDEN");

  const saved = await f.handlers.saveTemplate(request("POST", "/templates?organizationId=org-a", {
    user: "org-admin", body: JSON.stringify({ name: "门面", spec: emptySpec }),
  }), {});
  assert.equal(saved.status, 200);
  const templateId = (await saved.json()).data.template.id as string;

  const listed = await f.handlers.listTemplates(request("GET", "/templates?organizationId=org-a", { user: "org-admin" }), {});
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).data.items.length, 1);

  const deleted = await f.handlers.deleteTemplate(request("DELETE", "/templates/" + templateId + "?organizationId=org-a", { user: "org-admin" }), { templateId });
  assert.equal(deleted.status, 200, "DELETE 不带 body 不该 415");
  assert.equal((await deleted.json()).data.deleted, true);

  // 平台清点只对平台管理员开放；平台停用固定用 platform 级别（主办方拿不到管理员身份）。
  assert.equal((await f.handlers.listHostedSites(request("GET", "/admin/hosted-sites", { user: "manager" }), {})).status, 403);
  assert.equal((await f.handlers.listHostedSites(request("GET", "/admin/hosted-sites", { user: "admin" }), {})).status, 200);
  await f.handlers.savePage(request("PUT", "/page", { body: JSON.stringify({ spec: emptySpec, expectedRevision: 0 }) }), { eventId: f.eventId });
  const platformSuspend = await f.handlers.adminSuspendPage(request("POST", "/admin/hosted-sites/suspend", {
    user: "admin", body: JSON.stringify({ expectedRevision: 1, reason: "侵权投诉" }),
  }), { eventId: f.eventId });
  assert.equal(platformSuspend.status, 200);
  assert.equal((await platformSuspend.json()).data.suspension.kind, "platform");
});
