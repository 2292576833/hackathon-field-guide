import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { PlatformRole } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { HostedEventScope, OrganizerPrincipal } from "../../shared/organizer-contracts.ts";
import { defaultPageSpec } from "./blocks.ts";
import type { EventSitePageSpec } from "./model.ts";
import { normalizeSpec } from "./validation.ts";
import {
  createEventSiteService, type EventSiteAccessPort, type EventSiteAuditEvent, type EventSiteFactPort,
  type EventSitePublicEvent, type EventSiteService,
} from "./service.ts";

/**
 * 服务层验证：权限、CAS、发布闸门、审计、停用治理与只读投影。
 * 用临时内存 PGlite（加载根迁移 080 原文）+ 注入的假端口，不碰应用目录与生产数据。
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
    "INSERT INTO auth_users(id) VALUES ('manager'),('outsider'),('org-admin'),('platform-admin'),('other-org-admin');",
    "INSERT INTO organizer_organizations(id) VALUES ('org-a'),('org-b');",
  ].join("\n"));
  await engine.exec(await readFile(new URL("../../../migrations/080_event_site.sql", import.meta.url), "utf8"));
  database = { ...executor(engine), transaction: work => engine.transaction(transaction => work(executor(transaction))) };
});

after(async () => {
  await engine.close();
});

const AT = "2026-10-18T04:00:00.000Z";
const specOf = (): EventSitePageSpec => normalizeSpec(defaultPageSpec());

let eventCounter = 0;
let idCounter = 0;
let codeCounter = 0;

function nextCode(): string {
  codeCounter += 1;
  return "CODE" + String(codeCounter).padStart(12, "0");
}

function principalOf(userId: string, roles: readonly PlatformRole[] = [], failAt?: number): OrganizerPrincipal {
  let calls = 0;
  return {
    actor: { userId, platformRoles: roles },
    guard: async () => {
      calls += 1;
      if (failAt !== undefined && calls >= failAt) throw new DomainError("AUTH_SESSION_INVALID", "会话已失效，请重新登录。", { status: 401 });
    },
  };
}

interface Harness {
  readonly service: EventSiteService;
  readonly audit: { events: EventSiteAuditEvent[]; failing: boolean };
  readonly facts: { available: boolean; schedule: number; nodes: number; faq: number; registrationCloses: string | null };
  readonly shortCodes: { queue: string[] };
}

interface HarnessOptions {
  readonly audit?: boolean;
  readonly facts?: boolean;
  /** 固定短码候选（按顺序消费）；不传则自动生成不会重复的码。 */
  readonly codes?: string[];
}

const events = new Map<string, EventSitePublicEvent>();
const eventManagers = new Map<string, Set<string>>();
const orgAdmins = new Map<string, Set<string>>();
const admins = new Set<string>(["platform-admin"]);

function accessPort(): EventSiteAccessPort {
  return {
    async requireEventManager(_sql, principal, eventId): Promise<HostedEventScope> {
      if (!eventManagers.get(eventId)?.has(principal.actor.userId)) {
        throw new DomainError("ORGANIZER_FORBIDDEN", "你目前没有这家机构或这场比赛的操作权限。", { status: 403 });
      }
      const event = events.get(eventId);
      if (event === undefined) throw new DomainError("EVENT_NOT_FOUND", "没有找到这场比赛。", { status: 404 });
      return {
        organizationId: event.organizationId, organizationName: "机构", eventId: event.eventId, title: event.title,
        status: "published", revision: 1, publishedRevision: 1, timezone: "Asia/Shanghai",
        startsAt: AT, endsAt: AT, registrationOpensAt: null, registrationClosesAt: null, submissionClosesAt: null,
        modules: { registration: true, teams: true, judging: true, schedule: true, accommodation: false, mealVouchers: false, icebreaking: false },
        registration: { reviewRequired: false, capacity: null },
        teams: { mode: "free", minSize: 1, maxSize: 4, locksAt: null }, linkedEventId: null,
      };
    },
    async requireOrganizationAdmin(_sql, principal, organizationId): Promise<void> {
      if (!orgAdmins.get(organizationId)?.has(principal.actor.userId)) {
        throw new DomainError("ORGANIZER_FORBIDDEN", "只有机构管理员可以管理模板。", { status: 403 });
      }
    },
    async requirePlatformAdmin(_sql, principal): Promise<void> {
      if (!admins.has(principal.actor.userId) || !principal.actor.platformRoles.includes("admin")) {
        throw new DomainError("ORGANIZER_FORBIDDEN", "只有平台管理员可以执行这个操作。", { status: 403 });
      }
    },
    async publicEvent(_sql, eventId): Promise<EventSitePublicEvent | null> {
      return events.get(eventId) ?? null;
    },
  };
}

function harness(options: HarnessOptions = {}): Harness {
  const audit = { events: [] as EventSiteAuditEvent[], failing: false };
  const facts = { available: options.facts ?? false, schedule: 0, nodes: 0, faq: 0, registrationCloses: "2026-10-20T16:00:00.000Z" };
  const shortCodes = { queue: [...(options.codes ?? [])] };
  const factPort: EventSiteFactPort | null = facts.available ? {
    async schedule() {
      facts.schedule += 1;
      return { registrationCloses: facts.registrationCloses, submissionCloses: null, startsAt: null, endsAt: null, timezone: "Asia/Shanghai" };
    },
    async scheduleNodes() {
      facts.nodes += 1;
      return [{ id: "n1", title: "开幕", at: AT, kind: "ceremony" }];
    },
    async faqEntries() {
      facts.faq += 1;
      return [{ id: "f1", question: "可以个人参赛吗？", answer: "可以。" }];
    },
  } : null;
  const service = createEventSiteService({
    database, clock: { now: () => new Date(AT) }, ids: { next: () => "id-" + String(++idCounter) },
    access: accessPort(),
    audit: options.audit === false ? null : {
      async record(_sql, event) {
        if (audit.failing) throw new DomainError("ORGANIZER_AUDIT_FAILED", "审计写入失败。", { status: 503 });
        audit.events.push(event);
      },
    },
    facts: factPort,
    shortCodes: { next: () => shortCodes.queue.length > 0 ? shortCodes.queue.shift() as string : nextCode() },
  });
  return { service, audit, facts, shortCodes };
}

/** 每个用例一场新赛事，避免互相污染。 */
async function registerEvent(organizationId = "org-a"): Promise<EventSitePublicEvent> {
  eventCounter += 1;
  const eventId = "event-" + String(eventCounter);
  await database.query("INSERT INTO organizer_hosted_events(id,organization_id) VALUES($1,$2)", [eventId, organizationId]);
  const event: EventSitePublicEvent = { eventId, organizationId, title: "赛事 " + String(eventCounter), status: "published" };
  events.set(eventId, event);
  return event;
}

const failure = (code: string, status?: number) => (error: unknown): boolean => error instanceof DomainError
  && error.code === code && (status === undefined || error.status === status);

function managerOf(event: EventSitePublicEvent, userId = "manager"): OrganizerPrincipal {
  const current = eventManagers.get(event.eventId) ?? new Set<string>();
  current.add(userId);
  eventManagers.set(event.eventId, current);
  return principalOf(userId);
}

function orgAdminOf(organizationId = "org-a", userId = "org-admin"): OrganizerPrincipal {
  const current = orgAdmins.get(organizationId) ?? new Set<string>();
  current.add(userId);
  orgAdmins.set(organizationId, current);
  return principalOf(userId);
}

function platformAdmin(): OrganizerPrincipal {
  return principalOf("platform-admin", ["admin"]);
}

/** 建页 + 发布的最小前置。 */
async function publishedPage(h: Harness, event: EventSitePublicEvent, principal: OrganizerPrincipal) {
  const saved = await h.service.saveDraft(principal, event.eventId, { spec: specOf(), expectedRevision: 0 });
  const published = await h.service.publish(principal, event.eventId, { expectedRevision: saved.revision });
  return { saved, published };
}

/* ------------------------------------------------------------------ *
 * 权限与视图
 * ------------------------------------------------------------------ */

test("权限：只有本场 event_manage 能读；没建页时给默认起点而不是编造一条记录", async () => {
  const h = harness();
  const event = await registerEvent();
  await assert.rejects(h.service.pageForOrganizer(principalOf("outsider"), event.eventId), failure("ORGANIZER_FORBIDDEN", 403));

  const view = await h.service.pageForOrganizer(managerOf(event), event.eventId);
  assert.equal(view.exists, false);
  assert.equal(view.revision, 0);
  assert.equal(view.status, "draft");
  assert.equal(view.shortCode, null);
  assert.equal(view.spec, null);
  assert.equal(view.published, null);
  assert.deepEqual(view.suggestedSpec, specOf());
  assert.deepEqual(view.findings, [], "默认模块集本身没有提醒（体检只提醒半成品）");
  assert.equal(view.auditRecorded, true);

  // 不存在的赛事：权限端口先给 403/404，不会先泄露数据。
  await assert.rejects(h.service.pageForOrganizer(principalOf("manager"), "event-none"), failure("ORGANIZER_FORBIDDEN", 403));
});

test("未注入审计端口：主流程照常，但结果如实标注没有审计记录", async () => {
  const h = harness({ audit: false });
  const event = await registerEvent();
  const principal = managerOf(event);
  const saved = await h.service.saveDraft(principal, event.eventId, { spec: specOf(), expectedRevision: 0 });
  assert.equal(saved.created, true);
  assert.equal(saved.auditRecorded, false);
  assert.ok(saved.auditNotice !== null && saved.auditNotice.length > 0);
  assert.equal(h.audit.events.length, 0);
  const view = await h.service.pageForOrganizer(principal, event.eventId);
  assert.equal(view.auditRecorded, false);
  const published = await h.service.publish(principal, event.eventId, { expectedRevision: saved.revision });
  assert.equal(published.auditRecorded, false);
});

/* ------------------------------------------------------------------ *
 * 草稿 CAS 与闸门
 * ------------------------------------------------------------------ */

test("建页即草稿：revision 1、短码合规、审计两条，编辑页读回同一份规格", async () => {
  const h = harness();
  const event = await registerEvent();
  const principal = managerOf(event);
  const saved = await h.service.saveDraft(principal, event.eventId, { spec: defaultPageSpec(), expectedRevision: 0 });
  assert.equal(saved.created, true);
  assert.equal(saved.revision, 1);
  assert.equal(saved.status, "draft");
  assert.equal(saved.publishedRevision, null);
  assert.match(saved.shortCode, /^[A-Za-z0-9]{8,32}$/);
  assert.deepEqual(h.audit.events.map(item => item.action), ["page_created", "page_draft_saved"]);
  assert.ok(h.audit.events.every(item => item.actorUserId === "manager" && item.eventId === event.eventId));

  const view = await h.service.pageForOrganizer(principal, event.eventId);
  assert.equal(view.exists, true);
  assert.equal(view.revision, 1);
  assert.equal(view.shortCode, saved.shortCode);
  assert.deepEqual(view.spec, specOf());
  assert.deepEqual(view.findings, []);
});

test("草稿 CAS：版本不符给 409 与最新版本，不覆盖别人的改动", async () => {
  const h = harness();
  const event = await registerEvent();
  const principal = managerOf(event);
  const first = await h.service.saveDraft(principal, event.eventId, { spec: specOf(), expectedRevision: 0 });
  const second = await h.service.saveDraft(principal, event.eventId, {
    spec: normalizeSpec({ version: 1, blocks: [] }), expectedRevision: first.revision,
  });
  assert.equal(second.revision, 2);
  await assert.rejects(
    h.service.saveDraft(principal, event.eventId, { spec: specOf(), expectedRevision: 1 }),
    (error: unknown) => failure("EVENT_SITE_REVISION_CONFLICT", 409)(error) && (error as DomainError).latestRevision === 2,
  );
  // 已经有这一页时 expectedRevision=0 也是冲突，不会被当成"再建一次"。
  await assert.rejects(
    h.service.saveDraft(principal, event.eventId, { spec: specOf(), expectedRevision: 0 }),
    failure("EVENT_SITE_REVISION_CONFLICT", 409),
  );
  assert.equal((await h.service.pageForOrganizer(principal, event.eventId)).revision, 2);
});

test("输入校验：版本号必须是非负整数，规格必须先过归一的 37 个码", async () => {
  const h = harness();
  const event = await registerEvent();
  const principal = managerOf(event);
  for (const bad of [undefined, null, -1, 1.5, "1"]) {
    await assert.rejects(
      h.service.saveDraft(principal, event.eventId, { spec: specOf(), expectedRevision: bad }),
      failure("EVENT_SITE_INVALID_REVISION", 422),
    );
  }
  await assert.rejects(
    h.service.saveDraft(principal, event.eventId, {
      spec: { version: 1, blocks: [{ kind: "videoEmbed", id: "v1", variant: "x", priority: 3, collapse: false }] },
      expectedRevision: 0,
    }),
    failure("EVENT_SITE_UNKNOWN_BLOCK_KIND", 422),
  );
  await assert.rejects(
    h.service.saveDraft(principal, event.eventId, {
      spec: { version: 1, blocks: [{ kind: "richText", id: "r1", variant: "prose", priority: 3, collapse: false, text: "<b>x</b>" }] },
      expectedRevision: 0,
    }),
    failure("EVENT_SITE_HTML_NOT_ALLOWED", 422),
  );
});

/* ------------------------------------------------------------------ *
 * 发布：闸门、findings、不可变快照
 * ------------------------------------------------------------------ */

test("发布闸门：库里的草稿非法时 422 带 EVENT_SITE_* 码，且不写入线上快照", async () => {
  const h = harness();
  const event = await registerEvent();
  const principal = managerOf(event);
  const saved = await h.service.saveDraft(principal, event.eventId, { spec: specOf(), expectedRevision: 0 });
  // 模拟历史数据/直写造成的坏草稿：校验在读库这一侧再次执行。
  await database.query("UPDATE organizer_page_specs SET draft=$1::jsonb WHERE event_id=$2", [
    JSON.stringify({ version: 1, blocks: [{ kind: "videoEmbed", id: "v1", variant: "x", priority: 3, collapse: false }] }), event.eventId,
  ]);
  await assert.rejects(
    h.service.publish(principal, event.eventId, { expectedRevision: saved.revision }),
    failure("EVENT_SITE_UNKNOWN_BLOCK_KIND", 422),
  );
  const view = await h.service.pageForOrganizer(principal, event.eventId);
  assert.equal(view.published, null);
  assert.equal(view.publishedRevision, null);
});

test("体检 findings 不阻断发布：只附带，线上快照照样写入", async () => {
  const h = harness();
  const event = await registerEvent();
  const principal = managerOf(event);
  // 少了报名跳板：体检是 info，不是闸门。
  const withoutRegister = normalizeSpec({
    version: 1,
    blocks: [{ kind: "richText", id: "r1", variant: "prose", priority: 3, collapse: false, text: "只有一段公告" }],
  });
  const saved = await h.service.saveDraft(principal, event.eventId, { spec: withoutRegister, expectedRevision: 0 });
  assert.ok(saved.findings.some(item => item.code === "REVIEW_ACTION_MISSING"));

  const published = await h.service.publish(principal, event.eventId, { expectedRevision: saved.revision });
  assert.equal(published.status, "published");
  assert.equal(published.publishedRevision, 1);
  assert.equal(published.publishedAt, AT);
  assert.ok(published.findings.some(item => item.code === "REVIEW_ACTION_MISSING"), "findings 原样带回，不当成阻断");
  assert.ok(published.findings.every(item => item.code.startsWith("REVIEW_")));
  assert.ok(h.audit.events.some(item => item.action === "page_published"));
});

test("发布版本只能前进：内容没变拒发，内容变了发布版本加一", async () => {
  const h = harness();
  const event = await registerEvent();
  const principal = managerOf(event);
  const saved = await h.service.saveDraft(principal, event.eventId, { spec: specOf(), expectedRevision: 0 });
  const first = await h.service.publish(principal, event.eventId, { expectedRevision: saved.revision });
  assert.equal(first.publishedRevision, 1);

  await assert.rejects(
    h.service.publish(principal, event.eventId, { expectedRevision: first.revision }),
    failure("EVENT_SITE_NOTHING_TO_PUBLISH", 409),
  );

  const edited = await h.service.saveDraft(principal, event.eventId, {
    spec: normalizeSpec({ version: 1, blocks: [{ kind: "richText", id: "r1", variant: "prose", priority: 3, collapse: false, text: "改过" }] }),
    expectedRevision: first.revision,
  });
  const second = await h.service.publish(principal, event.eventId, { expectedRevision: edited.revision });
  assert.equal(second.publishedRevision, 2);
});

/* ------------------------------------------------------------------ *
 * 公开只读视图
 * ------------------------------------------------------------------ */

test("公开页：只有已发布快照，未发布/未知/格式不对都是同一个 404，不泄露草稿", async () => {
  const h = harness();
  const event = await registerEvent();
  const principal = managerOf(event);
  const saved = await h.service.saveDraft(principal, event.eventId, { spec: specOf(), expectedRevision: 0 });
  await assert.rejects(h.service.publicPage(saved.shortCode), failure("EVENT_SITE_PAGE_NOT_FOUND", 404));
  await assert.rejects(h.service.publicPage("does-not-exist"), failure("EVENT_SITE_PAGE_NOT_FOUND", 404));
  await assert.rejects(h.service.publicPage("short"), failure("EVENT_SITE_PAGE_NOT_FOUND", 404));

  await h.service.publish(principal, event.eventId, { expectedRevision: saved.revision });
  const secret = "只应留在草稿里的文案";
  await h.service.saveDraft(principal, event.eventId, {
    spec: normalizeSpec({ version: 1, blocks: [{ kind: "richText", id: "r1", variant: "prose", priority: 3, collapse: false, text: secret }] }),
    expectedRevision: 2,
  });
  const page = await h.service.publicPage(saved.shortCode);
  assert.equal(page.eventId, event.eventId);
  assert.equal(page.publishedRevision, 1);
  assert.deepEqual(page.spec, specOf());
  assert.equal(JSON.stringify(page).includes(secret), false, "公开页不得出现草稿内容");
  assert.equal(page.factsState, "unavailable", "没注入事实端口时如实标注不可用");
  assert.equal(page.facts.registrationCloses, null);
  assert.ok(page.factsNotice !== null);
  assert.equal(page.event?.title, event.title);
});

test("公开页事实值：只取被绑定到的字段，取不到就是 null（待确认），不推算", async () => {
  const h = harness({ facts: true });
  const event = await registerEvent();
  const principal = managerOf(event);
  await publishedPage(h, event, principal);
  const view = await h.service.pageForOrganizer(principal, event.eventId);
  assert.ok(view.shortCode !== null);
  const page = await h.service.publicPage(view.shortCode);
  assert.equal(page.factsState, "read");
  assert.equal(page.facts.registrationCloses, h.facts.registrationCloses);
  assert.equal(page.facts.submissionCloses, null);
  assert.equal(page.facts.timezone, "Asia/Shanghai");
  assert.deepEqual(page.facts.scheduleNodes, [{ id: "n1", title: "开幕", at: AT, kind: "ceremony" }]);
  assert.equal(page.facts.faqEntries?.length, 1);
  assert.equal(h.facts.schedule, 1);
  assert.equal(h.facts.nodes, 1);
  assert.equal(h.facts.faq, 1);

  // 只绑了 FAQ 的页面不应去读赛程：少读一次就是少一次越界机会。
  const faqOnly = normalizeSpec({
    version: 1,
    blocks: [{ kind: "faq", id: "f1", variant: "accordion", priority: 3, collapse: false, heading: null, text: null, items: [], image: null, binding: { source: "eventFaq", field: "faqEntries" } }],
  });
  const saved = await h.service.saveDraft(principal, event.eventId, { spec: faqOnly, expectedRevision: view.revision });
  await h.service.publish(principal, event.eventId, { expectedRevision: saved.revision });
  const second = await h.service.publicPage(view.shortCode);
  assert.equal(second.facts.scheduleNodes, null);
  assert.equal(h.facts.schedule, 1, "没有绑定赛程就不读赛程");
  assert.equal(h.facts.faq, 2);
});

/* ------------------------------------------------------------------ *
 * 停用与恢复
 * ------------------------------------------------------------------ */

test("主办方停用后公开页 404、快照仍在；恢复后同一份快照重新上线", async () => {
  const h = harness();
  const event = await registerEvent();
  const principal = managerOf(event);
  const { published } = await publishedPage(h, event, principal);
  const view = await h.service.pageForOrganizer(principal, event.eventId);
  assert.ok(view.shortCode !== null);

  const suspended = await h.service.suspend(principal, event.eventId, {
    expectedRevision: published.revision, kind: "organizer", reason: "改版中，先下线",
  });
  assert.equal(suspended.status, "suspended");
  assert.deepEqual(suspended.suspension.kind, "organizer");
  await assert.rejects(h.service.publicPage(view.shortCode), failure("EVENT_SITE_PAGE_NOT_FOUND", 404));
  assert.equal(h.audit.events.filter(item => item.action === "page_suspended").length, 1);

  const afterSuspend = await h.service.pageForOrganizer(principal, event.eventId);
  assert.ok(afterSuspend.published !== null, "停用不删线上快照");
  assert.equal(afterSuspend.suspension?.reason, "改版中，先下线");

  // 停用后不能发布、也不能重复停用。
  await assert.rejects(
    h.service.publish(principal, event.eventId, { expectedRevision: afterSuspend.revision }),
    failure("EVENT_SITE_PAGE_SUSPENDED", 409),
  );
  await assert.rejects(
    h.service.suspend(principal, event.eventId, { expectedRevision: afterSuspend.revision, kind: "organizer" }),
    failure("EVENT_SITE_PAGE_ALREADY_SUSPENDED", 409),
  );

  const resumed = await h.service.resume(principal, event.eventId, { expectedRevision: afterSuspend.revision });
  assert.equal(resumed.status, "published");
  const back = await h.service.publicPage(view.shortCode);
  assert.deepEqual(back.spec, specOf());
  await assert.rejects(
    h.service.resume(principal, event.eventId, { expectedRevision: resumed.revision }),
    failure("EVENT_SITE_PAGE_NOT_SUSPENDED", 409),
  );
});

test("平台停用：只有平台能停、主办方恢复必须 403", async () => {
  const h = harness();
  const event = await registerEvent();
  const manager = managerOf(event);
  const { published } = await publishedPage(h, event, manager);
  const view = await h.service.pageForOrganizer(manager, event.eventId);
  assert.ok(view.shortCode !== null);

  // 主办方冒用平台级别 → 403（平台管理员判定在服务层之前）。
  await assert.rejects(
    h.service.suspend(manager, event.eventId, { expectedRevision: published.revision, kind: "platform" }),
    failure("ORGANIZER_FORBIDDEN", 403),
  );

  const admin = platformAdmin();
  const suspended = await h.service.suspend(admin, event.eventId, {
    expectedRevision: published.revision, kind: "platform", reason: "收到侵权投诉",
  });
  assert.equal(suspended.suspension.kind, "platform");
  await assert.rejects(h.service.publicPage(view.shortCode), failure("EVENT_SITE_PAGE_NOT_FOUND", 404));

  await assert.rejects(
    h.service.resume(manager, event.eventId, { expectedRevision: suspended.revision }),
    failure("EVENT_SITE_PLATFORM_SUSPENSION_LOCKED", 403),
  );
  const resumed = await h.service.resumeByPlatform(admin, event.eventId, { expectedRevision: suspended.revision });
  assert.equal(resumed.status, "published");
  assert.deepEqual((await h.service.publicPage(view.shortCode)).spec, specOf());
});

/* ------------------------------------------------------------------ *
 * 短码
 * ------------------------------------------------------------------ */

test("换短码：旧链接立即失效、新链接可用；冲突重试有上限", async () => {
  const h = harness();
  const event = await registerEvent();
  const principal = managerOf(event);
  const saved = await h.service.saveDraft(principal, event.eventId, { spec: specOf(), expectedRevision: 0 });
  await h.service.publish(principal, event.eventId, { expectedRevision: saved.revision });

  const rotated = await h.service.rotateShortCode(principal, event.eventId, { expectedRevision: 2 });
  assert.notEqual(rotated.shortCode, saved.shortCode);
  assert.match(rotated.shortCode, /^[A-Za-z0-9]{8,32}$/);
  await assert.rejects(h.service.publicPage(saved.shortCode), failure("EVENT_SITE_PAGE_NOT_FOUND", 404));
  assert.equal((await h.service.publicPage(rotated.shortCode)).eventId, event.eventId);
  assert.equal(h.audit.events.filter(item => item.action === "page_short_code_rotated").length, 1);
});

test("短码冲突：撞码就换一个；连续 5 个都被占用就 503，不无限循环", async () => {
  const taken = "TAKEN12345678901";
  const fresh = "FRESH12345678901";
  const h = harness({ codes: [taken, fresh] });
  const other = await registerEvent();
  // 先让别人占住 taken。
  await h.service.saveDraft(managerOf(other), other.eventId, {
    spec: specOf(), expectedRevision: 0,
  });
  await database.query("UPDATE organizer_page_specs SET short_code=$1 WHERE event_id=$2", [taken, other.eventId]);

  const event = await registerEvent();
  const principal = managerOf(event);
  const saved = await h.service.saveDraft(principal, event.eventId, { spec: specOf(), expectedRevision: 0 });
  assert.equal(saved.shortCode, fresh, "第一个候选被占用，第二次拿到新码");

  const exhausted = harness({ codes: Array.from({ length: 5 }, () => taken) });
  const blocked = await registerEvent();
  await assert.rejects(
    exhausted.service.saveDraft(managerOf(blocked), blocked.eventId, { spec: specOf(), expectedRevision: 0 }),
    failure("EVENT_SITE_SHORT_CODE_EXHAUSTED", 503),
  );
  assert.equal(await database.query("SELECT 1 FROM organizer_page_specs WHERE event_id=$1", [blocked.eventId]).then(result => result.rowCount), 0);
});

/* ------------------------------------------------------------------ *
 * 模板
 * ------------------------------------------------------------------ */

test("模板权限：机构管理员才能读写；同名 409；列表只看本机构", async () => {
  const h = harness();
  const manager = managerOf(await registerEvent());
  const orgAdmin = orgAdminOf("org-a");
  await assert.rejects(
    h.service.saveTemplate(manager, "org-a", { name: "门面", spec: specOf() }),
    failure("ORGANIZER_FORBIDDEN", 403),
  );
  const saved = await h.service.saveTemplate(orgAdmin, "org-a", { name: "门面", spec: specOf() });
  assert.equal(saved.template.revision, 1);
  assert.equal(saved.template.organizationId, "org-a");
  assert.ok(h.audit.events.some(item => item.action === "page_template_saved"));

  await assert.rejects(
    h.service.saveTemplate(orgAdmin, "org-a", { name: "门面", spec: specOf() }),
    failure("EVENT_SITE_TEMPLATE_NAME_TAKEN", 409),
  );
  await assert.rejects(
    h.service.listTemplates(principalOf("other-org-admin"), "org-b"),
    failure("ORGANIZER_FORBIDDEN", 403),
  );
  orgAdminOf("org-b", "other-org-admin");
  const other = await h.service.listTemplates(principalOf("other-org-admin"), "org-b");
  assert.equal(other.items.length, 0);
  const mine = await h.service.listTemplates(orgAdmin, "org-a");
  assert.equal(mine.items.length, 1);
});

test("套用模板是复制快照：不建立跨赛事联动，之后改模板不影响页面", async () => {
  const h = harness();
  const orgAdmin = orgAdminOf("org-a");
  const template = await h.service.saveTemplate(orgAdmin, "org-a", { name: "极简页", spec: normalizeSpec({ version: 1, blocks: [] }) });
  const event = await registerEvent();
  const manager = managerOf(event);

  const applied = await h.service.applyTemplate(manager, event.eventId, { templateId: template.template.id, expectedRevision: 0 });
  assert.equal(applied.created, true);
  assert.equal(applied.revision, 1);
  assert.deepEqual((await h.service.pageForOrganizer(manager, event.eventId)).spec, { version: 1, blocks: [] });
  assert.ok(h.audit.events.some(item => item.action === "page_template_applied"));

  // 改模板：页面草稿一个字节都不动（没有联动）。
  await h.service.saveTemplate(orgAdmin, "org-a", {
    templateId: template.template.id, name: "极简页 v2", spec: specOf(), expectedRevision: 1,
  });
  assert.deepEqual((await h.service.pageForOrganizer(manager, event.eventId)).spec, { version: 1, blocks: [] });

  // 跨机构套用 → 404（不是 403：不告诉对方这个模板在别的机构存在）。
  const foreignOrgAdmin = orgAdminOf("org-b", "other-org-admin");
  const foreign = await h.service.saveTemplate(foreignOrgAdmin, "org-b", { name: "别家的", spec: specOf() });
  await assert.rejects(
    h.service.applyTemplate(manager, event.eventId, { templateId: foreign.template.id, expectedRevision: 2 }),
    failure("EVENT_SITE_TEMPLATE_NOT_FOUND", 404),
  );
});

test("模板内容损坏时套用 422；删除按机构隔离且记审计", async () => {
  const h = harness();
  const orgAdmin = orgAdminOf("org-a");
  const template = await h.service.saveTemplate(orgAdmin, "org-a", { name: "坏的", spec: specOf() });
  await database.query("UPDATE organizer_page_templates SET spec=$1::jsonb WHERE id=$2", [
    JSON.stringify({ version: 1, blocks: [{ kind: "videoEmbed", id: "v1", variant: "x", priority: 3, collapse: false }] }), template.template.id,
  ]);
  const event = await registerEvent();
  await assert.rejects(
    h.service.applyTemplate(managerOf(event), event.eventId, { templateId: template.template.id, expectedRevision: 0 }),
    failure("EVENT_SITE_TEMPLATE_INVALID", 422),
  );
  assert.equal(await database.query("SELECT 1 FROM organizer_page_specs WHERE event_id=$1", [event.eventId]).then(result => result.rowCount), 0);

  await assert.rejects(
    h.service.deleteTemplate(orgAdminOf("org-b", "other-org-admin"), "org-b", template.template.id),
    failure("EVENT_SITE_TEMPLATE_NOT_FOUND", 404),
  );
  const deleted = await h.service.deleteTemplate(orgAdmin, "org-a", template.template.id);
  assert.equal(deleted.deleted, true);
  assert.ok(h.audit.events.some(item => item.action === "page_template_deleted"));
  await assert.rejects(
    h.service.deleteTemplate(orgAdmin, "org-a", template.template.id),
    failure("EVENT_SITE_TEMPLATE_NOT_FOUND", 404),
  );
});

/* ------------------------------------------------------------------ *
 * 只读清点与事务性
 * ------------------------------------------------------------------ */

test("清点：机构管理员只看本机构，平台管理员看全部", async () => {
  const h = harness();
  const event = await registerEvent();
  await h.service.saveDraft(managerOf(event), event.eventId, { spec: specOf(), expectedRevision: 0 });
  const orgAdmin = orgAdminOf("org-a");
  const mine = await h.service.organizationPages(orgAdmin, "org-a");
  assert.equal(mine.organizationId, "org-a");
  assert.ok(mine.items.some(item => item.eventId === event.eventId && item.hasPublished === false));
  assert.equal(mine.truncated, false);
  await assert.rejects(h.service.organizationPages(principalOf("outsider"), "org-a"), failure("ORGANIZER_FORBIDDEN", 403));

  const admin = platformAdmin();
  const all = await h.service.platformPages(admin);
  assert.equal(all.organizationId, null);
  assert.ok(all.items.some(item => item.eventId === event.eventId));
  await assert.rejects(h.service.platformPages(principalOf("manager")), failure("ORGANIZER_FORBIDDEN", 403));
});

test("审计与业务同一事务：审计写失败，草稿也一起回滚", async () => {
  const h = harness();
  const event = await registerEvent();
  const principal = managerOf(event);
  h.audit.failing = true;
  await assert.rejects(
    h.service.saveDraft(principal, event.eventId, { spec: specOf(), expectedRevision: 0 }),
    failure("ORGANIZER_AUDIT_FAILED", 503),
  );
  const rows = await database.query("SELECT 1 FROM organizer_page_specs WHERE event_id=$1", [event.eventId]);
  assert.equal(rows.rowCount, 0, "审计失败不能留下半截记录");
});

test("会话在事务尾再次校验：中途失效则整笔回滚", async () => {
  const h = harness();
  const event = await registerEvent();
  const flaky = principalOf("manager", [], 2);
  const current = eventManagers.get(event.eventId) ?? new Set<string>();
  current.add("manager");
  eventManagers.set(event.eventId, current);
  await assert.rejects(
    h.service.saveDraft(flaky, event.eventId, { spec: specOf(), expectedRevision: 0 }),
    failure("AUTH_SESSION_INVALID", 401),
  );
  assert.equal((await database.query("SELECT 1 FROM organizer_page_specs WHERE event_id=$1", [event.eventId])).rowCount, 0);
});
