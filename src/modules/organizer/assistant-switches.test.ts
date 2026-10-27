import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { DomainError } from "../../shared/errors.ts";
import { createOrganizerHttpHandlers, organizerHttpRoute } from "./handlers.ts";
import { CONFIGURATION_KEYS } from "./validation.ts";
import { configurationOf, organizerError, organizerFixture } from "./testing.ts";
import type { OrganizerTestFixture } from "./testing.ts";

/**
 * P4 赛事级模块助手开关（规划34 §2.1 / §5.1；宪法 XIII）。
 *
 * 这些用例**刻意不使用**生产 7 个 key：夹具传的是 `beta`/`alpha` 这类测试键，
 * 用来证明 key 清单来自调用方（根注入）而不是模块内的第二份注册表。
 */
const KEYS = ["beta","alpha"] as const;

async function setup(t: TestContext, assistantKeys?: readonly string[]) {
  const f = await organizerFixture(t, assistantKeys ? { assistantKeys } : {});
  const a = await f.approvedOrganization();
  const event = await f.createEvent(a.organization.id, a.principal);
  return { f, a, event };
}
async function rejects(fn: () => Promise<unknown>, code: string, status: number) {
  await assert.rejects(fn, (error: unknown) => error instanceof DomainError && error.code === code && error.status === status);
}
const auditRows = async (f: OrganizerTestFixture) => (await f.direct.query<{ action: string; entity_id: string; event_id: string; organization_id: string; actor_user_id: string; revision: number }>(
  "SELECT action,entity_id,event_id,organization_id,actor_user_id,revision FROM organizer_audit_events WHERE action='assistant_switch_changed' ORDER BY created_at,id")).rows;
const read = (value: Response) => value.json() as Promise<{ data?: unknown; requestId: string; error?: { code: string } }>;
const request = (method = "GET", body?: unknown) => new Request("https://organizer.local/api/v1/test", {
  method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
});

test("P4 默认全开且顺序稳定：没有行的键一律 enabled:true/revision:0，顺序严格按传入 assistantKeys", async t => {
  const { f, event } = await setup(t, [...KEYS]);
  assert.deepEqual(await f.service.listEventAssistantSwitches(f.users.ownerA, event.eventId), {
    eventId: event.eventId,
    switches: [{ assistantKey: "beta", enabled: true, revision: 0 }, { assistantKey: "alpha", enabled: true, revision: 0 }],
  });
  // 只读不补写占位行：默认值来自派生，不落库。
  assert.equal((await f.counts()).organizer_event_assistant_switches, 0);

  // 换一份传入列表（不同顺序、不同键集合），结果随之改变 —— 证明没有内置注册表。
  const other = await organizerFixture(t, { assistantKeys: ["alpha","beta","gamma"] });
  const org = await other.approvedOrganization();
  const otherEvent = await other.createEvent(org.organization.id, org.principal);
  assert.deepEqual((await other.service.listEventAssistantSwitches(other.users.ownerA, otherEvent.eventId)).switches.map(item => item.assistantKey), ["alpha","beta","gamma"]);
});

test("P4 首次设置写一行（revision=1）并在同一事务写既有审计，且只记 key 与 enabled", async t => {
  const { f, a, event } = await setup(t, [...KEYS]);
  const before = await f.counts();
  const view = await f.service.setEventAssistantSwitch(f.users.ownerA, event.eventId, { assistantKey: "beta", enabled: false, expectedRevision: 0 });
  assert.deepEqual(view, {
    eventId: event.eventId,
    switches: [{ assistantKey: "beta", enabled: false, revision: 1 }, { assistantKey: "alpha", enabled: true, revision: 0 }],
  });

  const rows = (await f.direct.query<{ enabled: boolean; revision: number; updated_by_user_id: string; document: Record<string, unknown> }>(
    "SELECT enabled,revision,updated_by_user_id,document FROM organizer_event_assistant_switches WHERE event_id=$1 AND assistant_key=$2", [event.eventId, "beta"])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.enabled, false);
  assert.equal(rows[0]!.revision, 1);
  assert.equal(rows[0]!.updated_by_user_id, "ownerA");
  // 索引列与 document 是同一份事实（同值同构），不是两份可漂移的配置。
  assert.deepEqual(rows[0]!.document, {
    eventId: event.eventId, organizationId: a.organization.id, assistantKey: "beta",
    enabled: false, revision: 1, updatedByUserId: "ownerA", updatedAt: f.now().toISOString(),
  });

  // 再开一个键：审计 entity_id 表达 enabled 一侧。
  await f.service.setEventAssistantSwitch(f.users.ownerA, event.eventId, { assistantKey: "alpha", enabled: true, expectedRevision: 0 });
  const after = await f.counts();
  assert.equal(after.organizer_event_assistant_switches! - before.organizer_event_assistant_switches!, 2);
  assert.equal(after.organizer_audit_events! - before.organizer_audit_events!, 2);
  assert.deepEqual(await auditRows(f), [
    { action: "assistant_switch_changed", entity_id: "beta:disabled", event_id: event.eventId, organization_id: a.organization.id, actor_user_id: "ownerA", revision: 1 },
    { action: "assistant_switch_changed", entity_id: "alpha:enabled", event_id: event.eventId, organization_id: a.organization.id, actor_user_id: "ownerA", revision: 1 },
  ]);
  // 审计表没有 payload 列，助手指令/输出内容没有入口。
  assert.equal((await f.direct.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name='organizer_audit_events'")).rows.some(row => /prompt|payload|content|message/i.test(row.column_name)), false);
});

test("P4 版本：已存在的键必须匹配当前 revision（否则 409 且不覆盖），每次成功只 +1", async t => {
  const { f, event } = await setup(t, [...KEYS]);
  await f.service.setEventAssistantSwitch(f.users.ownerA, event.eventId, { assistantKey: "beta", enabled: false, expectedRevision: 0 });
  const before = await f.counts();
  await rejects(() => f.service.setEventAssistantSwitch(f.users.ownerA, event.eventId, { assistantKey: "beta", enabled: true, expectedRevision: 0 }), "ORGANIZER_REVISION_CONFLICT", 409);
  const stale = (await f.direct.query<{ enabled: boolean; revision: number }>("SELECT enabled,revision FROM organizer_event_assistant_switches WHERE event_id=$1 AND assistant_key='beta'", [event.eventId])).rows[0]!;
  assert.deepEqual(stale, { enabled: false, revision: 1 });
  assert.deepEqual(await f.counts(), before, "冲突不产生任何新事实（含审计）");

  const next = await f.service.setEventAssistantSwitch(f.users.ownerA, event.eventId, { assistantKey: "beta", enabled: true, expectedRevision: 1 });
  assert.deepEqual(next.switches[0], { assistantKey: "beta", enabled: true, revision: 2 });
  const after = await f.counts();
  assert.equal(after.organizer_event_assistant_switches! - before.organizer_event_assistant_switches!, 0, "更新既有行而不是再插一行");
  assert.equal(after.organizer_audit_events! - before.organizer_audit_events!, 1);
  assert.equal((await auditRows(f)).at(-1)!.entity_id, "beta:enabled");
});

test("P4 输入：不在传入列表的 assistantKey 一律 422；未知字段/非布尔/缺版本同样 422，且不写任何表", async t => {
  const { f, event } = await setup(t, [...KEYS]);
  const before = await f.counts();
  const invalid = [
    { assistantKey: "overview", enabled: false, expectedRevision: 0 },
    { assistantKey: "beta", enabled: "false", expectedRevision: 0 },
    { assistantKey: "beta", enabled: false, expectedRevision: -1 },
    { assistantKey: "beta", enabled: false, expectedRevision: 1.5 },
    { assistantKey: "beta", enabled: false, expectedRevision: 0, instruction: "汇总" },
    { assistantKey: "", enabled: false, expectedRevision: 0 },
    { assistantKey: "beta", enabled: false },
  ];
  for (const input of invalid) await rejects(() => f.service.setEventAssistantSwitch(f.users.ownerA, event.eventId, input), "ORGANIZER_INPUT_INVALID", 422);
  assert.deepEqual(await f.counts(), before);
});

test("P4 未接入注册表：list 只报空开关集，set 明确 503 拒绝且不写任何表", async t => {
  const { f, event } = await setup(t);
  const before = await f.counts();
  assert.deepEqual(await f.service.listEventAssistantSwitches(f.users.ownerA, event.eventId), { eventId: event.eventId, switches: [] });
  await rejects(() => f.service.setEventAssistantSwitch(f.users.ownerA, event.eventId, { assistantKey: "beta", enabled: true, expectedRevision: 0 }), "ORGANIZER_ASSISTANT_SWITCH_UNAVAILABLE", 503);
  assert.deepEqual(await f.counts(), before);
});

test("P4 不随发布版本冻结：改开关后赛事 revision/publishedRevision/preview/changedFields 逐字段不变，审计恰好 +1", async t => {
  const { f, a, event } = await setup(t, [...KEYS]);
  const published = await f.publish(event, a.principal);
  const beforeEvent = await f.service.getManagedEvent(a.principal, event.eventId);
  const beforePreview = await f.service.previewEvent(a.principal, event.eventId);
  const beforeHistory = await f.service.listPublicationHistory(a.principal, event.eventId);
  const before = await f.counts();

  await f.service.setEventAssistantSwitch(a.principal, event.eventId, { assistantKey: "beta", enabled: false, expectedRevision: 0 });

  const afterEvent = await f.service.getManagedEvent(a.principal, event.eventId);
  const afterPreview = await f.service.previewEvent(a.principal, event.eventId);
  assert.deepEqual(afterEvent, beforeEvent);
  assert.deepEqual(afterPreview, beforePreview);
  assert.equal(afterEvent.revision, beforeEvent.revision);
  assert.equal(afterEvent.publishedRevision, beforeEvent.publishedRevision);
  assert.deepEqual(afterPreview.changedFields, beforePreview.changedFields);
  assert.deepEqual(afterPreview.publicProjection, beforePreview.publicProjection);
  assert.deepEqual(await f.service.listPublicationHistory(a.principal, event.eventId), beforeHistory);
  assert.equal(afterEvent.status, published.status);

  const after = await f.counts();
  assert.equal(after.organizer_audit_events! - before.organizer_audit_events!, 1, "只有审计 +1");
  for (const table of ["organizer_hosted_events","organizer_event_publications","organizer_publication_changes","organizer_event_profiles","organizer_organizations"] as const) {
    assert.equal(after[table], before[table], table);
  }

  // 配置面里根本不存在这个事实：既不在 CONFIGURATION_KEYS，也不能经赛事配置写入。
  assert.equal(CONFIGURATION_KEYS.some(key => /assistant/i.test(key)), false);
  assert.equal(Object.hasOwn(afterEvent.community ?? {}, "assistants"), false);
  await f.service.setEventAssistantSwitch(a.principal, event.eventId, { assistantKey: "alpha", enabled: false, expectedRevision: 0 });
  await rejects(() => f.service.updateEvent(a.principal, event.eventId, { ...configurationOf(published), expectedRevision: published.revision, assistantSwitches: { beta: false } }), "ORGANIZER_INPUT_INVALID", 422);
  assert.equal((await f.service.getManagedEvent(a.principal, event.eventId)).revision, beforeEvent.revision);
  assert.equal((await f.service.previewEvent(a.principal, event.eventId)).changedFields.length, beforePreview.changedFields.length);
});

test("P4 越权：非本场工作人员 403，跨赛事/跨机构不可见，归档与不存在的赛事明确拒绝", async t => {
  const { f, a, event } = await setup(t, [...KEYS]);
  const b = await f.approvedOrganization("ownerB");
  const eventB = await f.createEvent(b.organization.id, b.principal);
  await f.service.grantStaff(a.principal, a.organization.id, { expectedOrganizationRevision: a.organization.revision, userId: "staff", eventId: event.eventId, role: "staff", capabilities: ["registration_manage"] });
  await f.service.grantStaff(b.principal, b.organization.id, { expectedOrganizationRevision: b.organization.revision, userId: "reviewer", eventId: eventB.eventId, role: "staff", capabilities: ["event_manage"] });

  const before = await f.counts();
  for (const caller of [f.users.staff, f.users.reviewer, f.users.ownerB, f.users.administrator]) {
    await rejects(() => f.service.listEventAssistantSwitches(caller, event.eventId), "ORGANIZER_FORBIDDEN", 403);
    await rejects(() => f.service.setEventAssistantSwitch(caller, event.eventId, { assistantKey: "beta", enabled: false, expectedRevision: 0 }), "ORGANIZER_FORBIDDEN", 403);
  }
  // 本场只授 registration_manage 的工作人员不能改开关；但另一位工作人员在**本场**有 event_manage 时可以。
  await f.service.grantStaff(a.principal, a.organization.id, { expectedOrganizationRevision: (await f.service.listOrganizations(a.principal)).find(value => value.id === a.organization.id)!.revision, userId: "outsider", eventId: event.eventId, role: "staff", capabilities: ["event_manage"] });
  assert.equal((await f.service.listEventAssistantSwitches(f.users.outsider, event.eventId)).switches.length, 2);
  // 在另一场有 event_manage 不能越到本场。
  await rejects(() => f.service.listEventAssistantSwitches(f.users.reviewer, event.eventId), "ORGANIZER_FORBIDDEN", 403);
  assert.equal((await f.service.listEventAssistantSwitches(f.users.reviewer, eventB.eventId)).eventId, eventB.eventId);
  await rejects(() => f.service.listEventAssistantSwitches(a.principal, "no-such-event"), "ORGANIZER_NOT_FOUND", 404);
  assert.equal((await f.counts()).organizer_event_assistant_switches, before.organizer_event_assistant_switches, "拒绝路径不写开关行");

  const archived = await f.service.getManagedEvent(a.principal, event.eventId);
  await f.service.archiveEvent(a.principal, event.eventId, { expectedRevision: archived.revision });
  await rejects(() => f.service.listEventAssistantSwitches(a.principal, event.eventId), "ORGANIZER_FORBIDDEN", 403);
});

test("P4 HTTP：GET 读 / POST 写走真实 principal，kind 解析精确，方法不匹配 405", async t => {
  // 路径解析只认确切段；形近路径（含 module-assistants 目录本身）都不属于本 kind。
  assert.deepEqual(organizerHttpRoute(["organizer","events","e","module-assistant-switches"]), { kind: "assistantSwitches", eventId: "e" });
  assert.equal(organizerHttpRoute(["organizer","events","e","module-assistant-switches","extra"]), null);
  assert.equal(organizerHttpRoute(["organizer","events","e","module-assistants"]), null);

  const { f, event } = await setup(t, [...KEYS]);
  const handler = createOrganizerHttpHandlers({ service: f.service, authenticate: async () => f.users.ownerA, authorizeMutation: async () => {}, requestId: () => "http-assistant-switches" });
  const listed = await handler.handle(request("GET"), { kind: "assistantSwitches", eventId: event.eventId });
  assert.equal(listed.status, 200);
  assert.deepEqual((await read(listed)).data, { eventId: event.eventId, switches: [{ assistantKey: "beta", enabled: true, revision: 0 }, { assistantKey: "alpha", enabled: true, revision: 0 }] });
  assert.equal(listed.headers.get("cache-control"), "private, no-store");

  const written = await handler.handle(request("POST", { assistantKey: "beta", enabled: false, expectedRevision: 0 }), { kind: "assistantSwitches", eventId: event.eventId });
  assert.equal(written.status, 200);
  assert.deepEqual((await read(written)).data, { eventId: event.eventId, switches: [{ assistantKey: "beta", enabled: false, revision: 1 }, { assistantKey: "alpha", enabled: true, revision: 0 }] });
  // 方法已知时根可显式按 POST 分派；GET 由 methods 表判 405 且不触达 authenticate。
  let calls = 0;
  const explicit = createOrganizerHttpHandlers({ service: f.service, authenticate: async () => { calls++; return f.users.ownerA; }, authorizeMutation: async () => {}, requestId: () => "http-assistant-explicit" });
  const posted = await explicit.handle(request("POST", { assistantKey: "alpha", enabled: false, expectedRevision: 0 }), { kind: "setAssistantSwitch", eventId: event.eventId });
  assert.equal(posted.status, 200);
  const wrongMethod = await explicit.handle(request("GET"), { kind: "setAssistantSwitch", eventId: event.eventId });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");
  assert.equal((await read(wrongMethod)).error?.code, "METHOD_NOT_ALLOWED");
  assert.equal(calls, 1);

  // 越权身份与非法 key 在 HTTP 边界上是 403 / 422。
  const outsider = createOrganizerHttpHandlers({ service: f.service, authenticate: async () => f.users.reviewer, authorizeMutation: async () => {}, requestId: () => "http-assistant-outsider" });
  assert.equal((await outsider.handle(request("GET"), { kind: "assistantSwitches", eventId: event.eventId })).status, 403);
  assert.equal((await explicit.handle(request("POST", { assistantKey: "overview", enabled: false, expectedRevision: 0 }), { kind: "setAssistantSwitch", eventId: event.eventId })).status, 422);
});

test("P4 唯一新表：document 与索引列不一致、主键重复、跨机构外键都被数据库拒绝", async t => {
  const { f, a, event } = await setup(t, [...KEYS]);
  const b = await f.approvedOrganization("ownerB");
  const base = { eventId: event.eventId, organizationId: a.organization.id, assistantKey: "beta", enabled: false, revision: 1, updatedByUserId: "ownerA", updatedAt: f.now().toISOString() };
  const insert = (document: Record<string, unknown>, organizationId = a.organization.id, enabled = false, revision = 1) => f.direct.query(
    "INSERT INTO organizer_event_assistant_switches(event_id,organization_id,assistant_key,enabled,revision,updated_by_user_id,updated_at,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",
    [event.eventId, organizationId, "beta", enabled, revision, "ownerA", f.now().toISOString(), JSON.stringify(document)]);
  const withoutEnabled: Record<string, unknown> = { ...base }; delete withoutEnabled.enabled;
  const dbRejects = (promise: Promise<unknown>, why: string) => assert.rejects(promise, () => true, why);

  await dbRejects(insert({ ...base, enabled: true }), "列说关、文档说开必须被拒");
  await dbRejects(insert(withoutEnabled), "缺 document.enabled 不能让 CHECK 静默通过");
  await dbRejects(insert({ ...base, revision: 2 }), "document.revision 与索引列不一致必须被拒");
  await insert(base);
  await dbRejects(insert(base), "一赛事一助手键只有一行");
  await dbRejects(insert({ ...base, organizationId: b.organization.id }, b.organization.id), "跨机构赛事无法挂开关");
  assert.equal((await f.counts()).organizer_event_assistant_switches, 1);
});
