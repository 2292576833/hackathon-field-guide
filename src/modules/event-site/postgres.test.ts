import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { defaultPageSpec } from "./blocks.ts";
import type { EventSitePageSpec } from "./model.ts";
import { normalizeSpec } from "./validation.ts";
import {
  createPage, createShortCodeSource, deleteTemplate,
  findPageByShortCode, insertTemplate, isShortCode, listAllPages, listOrganizationPages, listTemplates, publish,
  readPage, readTemplate, resume, rotateShortCode, saveDraft, shortCodeFromBytes, suspend, updateTemplate,
  type EventSitePageRecord,
} from "./postgres.ts";

/**
 * 存储层验证：只开一个临时内存 PGlite，加载**根迁移 080 原文**（不复制表结构），
 * 于是这里的 CHECK / UNIQUE / 外键就是生产的那一套。不碰应用目录、不碰生产数据。
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
    "INSERT INTO auth_users(id) VALUES ('alice'),('bob'),('admin');",
    "INSERT INTO organizer_organizations(id) VALUES ('org-a'),('org-b');",
    "INSERT INTO organizer_hosted_events(id,organization_id) VALUES ('event-a','org-a'),('event-b','org-b');",
  ].join("\n"));
  // 直接读根迁移原文：本模块不建第二套表，也不在自己的目录里复制一份结构。
  await engine.exec(await readFile(new URL("../../../migrations/080_event_site.sql", import.meta.url), "utf8"));
  database = { ...executor(engine), transaction: work => engine.transaction(transaction => work(executor(transaction))) };
});

after(async () => {
  await engine.close();
});

const AT = "2026-10-18T04:00:00.000Z";
const LATER = "2026-10-18T05:00:00.000Z";
const defaultSpec = (): EventSitePageSpec => normalizeSpec(defaultPageSpec());

const code = (value: string) => (error: unknown): boolean => error instanceof DomainError && error.code === value;

let seeded = 0;
/** 每个用例自己一个赛事，互不影响；短码沿用 16 位字母数字。 */
function eventId(): string {
  seeded += 1;
  return "event-" + String(seeded);
}

async function makeEvent(): Promise<string> {
  const id = eventId();
  await database.query("INSERT INTO organizer_hosted_events(id,organization_id) VALUES($1,'org-a')", [id]);
  return id;
}

async function newPage(): Promise<{ eventId: string; record: EventSitePageRecord }> {
  const event = await makeEvent();
  // 每个赛事一个不重复的短码（真实生成器是随机的，这里要确定性）。
  const shortCode = "PAGE" + String(seeded).padStart(12, "0");
  const created = await createPage(database, event, {
    id: "page-" + event, organizationId: "org-a", shortCode, spec: defaultSpec(), now: AT,
  });
  assert.equal(created, 1);
  const record = await readPage(database, event);
  assert.ok(record !== null);
  return { eventId: event, record };
}

/* ------------------------------------------------------------------ *
 * 短码：不透明随机串（正则、长度、无偏、可注入）
 * ------------------------------------------------------------------ */

test("短码是可注入的随机串：长度 8-32、只含字母数字、跳过有偏样本、不凑长度", () => {
  assert.equal(isShortCode("abcdEFGH12345678"), true);
  assert.equal(isShortCode("short"), false);
  assert.equal(isShortCode("x".repeat(33)), false);
  assert.equal(isShortCode("abcd-EFGH1234"), false);
  assert.equal(isShortCode(12345678), false);

  // 13 是合法的字母表下标；248 以上被丢弃（62*4=248，取模无偏）。
  const first = shortCodeFromBytes([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  assert.equal(first, "ABCDEFGHIJKLMNOP");
  assert.equal(shortCodeFromBytes([248, 249, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]), "ABCDEFGHIJKLMNOP");
  // 字节不够就抛错，不重复填充。
  assert.throws(() => shortCodeFromBytes([0, 1]), code("EVENT_SITE_SHORT_CODE_INVALID"));
  assert.throws(() => shortCodeFromBytes([0, 1, 2, 3, 4, 5, 6, 7], 4), code("EVENT_SITE_SHORT_CODE_INVALID"));

  const source = createShortCodeSource({ random: () => new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160]) });
  const generated = source.next();
  assert.equal(generated.length, 16);
  assert.equal(isShortCode(generated), true);
  assert.notEqual(source.next(), generateAllSame());
});

function generateAllSame(): string {
  return createShortCodeSource({ random: () => new Uint8Array(16).fill(7) }).next();
}

test("短码按库里的 CHECK 校验：不合规的短码被数据库拒绝", async () => {
  const event = await makeEvent();
  await assert.rejects(
    createPage(database, event, { id: "page-bad", organizationId: "org-a", shortCode: "short", spec: defaultSpec(), now: AT }),
    /short_code|check constraint/i,
  );
});

/* ------------------------------------------------------------------ *
 * 建页与读取
 * ------------------------------------------------------------------ */

test("一赛事一条：建页返回 revision 1，按赛事与按短码都能读回同一份草稿", async () => {
  const { eventId: event, record } = await newPage();
  assert.equal(record.status, "draft");
  assert.equal(record.revision, 1);
  assert.equal(record.organizationId, "org-a");
  assert.deepEqual(record.draft, defaultSpec());
  assert.equal(record.published, null);
  assert.equal(record.publishedRevision, null);
  assert.equal(record.publishedAt, null);
  assert.equal(record.suspension, null);
  assert.deepEqual(await findPageByShortCode(database, record.shortCode), record);

  // 同一赛事再建一次：ON CONFLICT 返回 null，不会覆盖先到的那一条。
  const again = await createPage(database, event, {
    id: "page-again", organizationId: "org-a", shortCode: "ZZZZZZZZZZZZZZZZ", spec: defaultSpec(), now: LATER,
  });
  assert.equal(again, null);
  assert.equal((await readPage(database, event))?.revision, 1);
  assert.equal(await findPageByShortCode(database, "ZZZZZZZZZZZZZZZZ"), null);
  assert.equal(await readPage(database, "event-none"), null);
});

/* ------------------------------------------------------------------ *
 * CAS
 * ------------------------------------------------------------------ */

test("草稿 CAS：版本不符改不到行（服务层据此翻成 409）", async () => {
  const { eventId: event } = await newPage();
  const changed = normalizeSpec({ version: 1, blocks: [] });
  assert.equal(await saveDraft(database, event, { spec: changed, expectedRevision: 1, now: LATER }), 2);
  assert.equal(await saveDraft(database, event, { spec: defaultSpec(), expectedRevision: 1, now: LATER }), null);
  const record = await readPage(database, event);
  assert.equal(record?.revision, 2);
  assert.deepEqual(record?.draft, { version: 1, blocks: [] });
});

/* ------------------------------------------------------------------ *
 * 发布：唯一写入者与不可变证据
 * ------------------------------------------------------------------ */

test("published 只有 publish 写得动：草稿、短码、停用、恢复都不改快照", async () => {
  const { eventId: event } = await newPage();
  const snapshot = normalizeSpec(defaultPageSpec());
  assert.equal(await publish(database, event, { snapshot: JSON.stringify(snapshot), publishedRevision: 1, expectedRevision: 1, at: LATER }), 2);

  let record = await readPage(database, event);
  assert.equal(record?.status, "published");
  assert.equal(record?.publishedRevision, 1);
  assert.equal(record?.publishedAt, LATER);
  assert.deepEqual(record?.published, snapshot);
  const bytes = JSON.stringify(record?.published);

  // 改草稿：线上快照一个字节都不动。
  const edited = normalizeSpec({
    version: 1,
    blocks: [{ kind: "richText", id: "r1", variant: "prose", priority: 3, collapse: false, text: "改过的草稿" }],
  });
  assert.equal(await saveDraft(database, event, { spec: edited, expectedRevision: 2, now: LATER }), 3);
  record = await readPage(database, event);
  assert.equal(JSON.stringify(record?.published), bytes);
  assert.deepEqual(record?.draft, edited);

  // 换短码：只换码。
  assert.equal(await rotateShortCode(database, event, { shortCode: "ROTATED123456789", expectedRevision: 3, now: LATER }), 4);
  record = await readPage(database, event);
  assert.equal(JSON.stringify(record?.published), bytes);
  assert.equal(record?.shortCode, "ROTATED123456789");

  // 停用 / 恢复：只改状态与停用字段。
  assert.equal(await suspend(database, event, { expectedRevision: 4, kind: "organizer", by: "alice", reason: "临时下线", at: LATER }), 5);
  record = await readPage(database, event);
  assert.equal(JSON.stringify(record?.published), bytes);
  assert.equal(record?.status, "suspended");
  assert.equal(record?.publishedRevision, 1);
  assert.equal(record?.publishedAt, null, "停用不带「最近上线时间」：published_at 只在 published 时存在");
  assert.deepEqual(record?.suspension, { kind: "organizer", reason: "临时下线", at: LATER, by: "alice" });

  assert.equal(await resume(database, event, { expectedRevision: 5, nextStatus: "published", publishedAt: LATER, at: LATER }), 6);
  record = await readPage(database, event);
  assert.equal(JSON.stringify(record?.published), bytes);
  assert.equal(record?.status, "published");
  assert.equal(record?.suspension, null);
  assert.equal(record?.publishedAt, LATER);
});

test("停用态下 publish 被 SQL 挡住；发布版本号每次加一", async () => {
  const { eventId: event } = await newPage();
  assert.equal(await publish(database, event, { snapshot: JSON.stringify(defaultSpec()), publishedRevision: 1, expectedRevision: 1, at: LATER }), 2);
  const second = normalizeSpec({ version: 1, blocks: [] });
  assert.equal(await publish(database, event, { snapshot: JSON.stringify(second), publishedRevision: 2, expectedRevision: 2, at: LATER }), 3);
  const record = await readPage(database, event);
  assert.equal(record?.publishedRevision, 2);
  assert.deepEqual(record?.published, second);

  assert.equal(await suspend(database, event, { expectedRevision: 3, kind: "organizer", by: "alice", reason: null, at: LATER }), 4);
  assert.equal(await publish(database, event, { snapshot: JSON.stringify(second), publishedRevision: 3, expectedRevision: 4, at: LATER }), null);
  assert.equal((await readPage(database, event))?.publishedRevision, 2);
});

test("080 的两条一致性 CHECK 是硬的：停用时快照与发布时间不能同时在", async () => {
  const { eventId: event } = await newPage();
  await publish(database, event, { snapshot: JSON.stringify(defaultSpec()), publishedRevision: 1, expectedRevision: 1, at: LATER });
  await suspend(database, event, { expectedRevision: 2, kind: "platform", by: "admin", reason: "违规内容", at: LATER });

  // 想把发布时间补回来（让三件套同时在）→ 被库拒绝：这就是停用只能清时间戳的原因。
  await assert.rejects(
    database.query("UPDATE organizer_page_specs SET published_at=$1::timestamptz WHERE event_id=$2", [LATER, event]),
    /check constraint|violates/i,
  );
  // 想让状态回到 published 但少一个字段 → 同样被拒。
  await assert.rejects(
    database.query("UPDATE organizer_page_specs SET status='published', published_at=NULL WHERE event_id=$1", [event]),
    /check constraint|violates/i,
  );
});

test("从没发布过就停用：恢复回 draft，不凭空造一个线上快照", async () => {
  const { eventId: event } = await newPage();
  assert.equal(await suspend(database, event, { expectedRevision: 1, kind: "organizer", by: "alice", reason: "先下线", at: LATER }), 2);
  const suspended = await readPage(database, event);
  assert.equal(suspended?.status, "suspended");
  assert.equal(suspended?.published, null);
  assert.equal(await resume(database, event, { expectedRevision: 2, nextStatus: "draft", publishedAt: null, at: LATER }), 3);
  const resumed = await readPage(database, event);
  assert.equal(resumed?.status, "draft");
  assert.equal(resumed?.published, null);
  assert.equal(resumed?.publishedAt, null);
});


/* ------------------------------------------------------------------ *
 * 短码唯一与切换
 * ------------------------------------------------------------------ */

test("换短码：旧码立刻查不到，撞到已占用的码给 409", async () => {
  const first = await newPage();
  const second = await newPage();
  assert.equal(await rotateShortCode(database, first.eventId, { shortCode: "NEWCODE123456789", expectedRevision: 1, now: LATER }), 2);
  assert.equal(await findPageByShortCode(database, first.record.shortCode), null);
  assert.equal((await findPageByShortCode(database, "NEWCODE123456789"))?.eventId, first.eventId);

  await assert.rejects(
    rotateShortCode(database, second.eventId, { shortCode: "NEWCODE123456789", expectedRevision: 1, now: LATER }),
    code("EVENT_SITE_SHORT_CODE_TAKEN"),
  );
  assert.equal((await readPage(database, second.eventId))?.shortCode, second.record.shortCode);
});

/* ------------------------------------------------------------------ *
 * 模板
 * ------------------------------------------------------------------ */

test("模板：机构内名字唯一、更新有 CAS、跨机构读不到", async () => {
  const spec = defaultSpec();
  const created = await insertTemplate(database, {
    id: "tpl-1", organizationId: "org-a", name: "默认门面", spec, createdBy: "alice", now: AT,
  });
  assert.equal(created.revision, 1);
  assert.deepEqual(created.spec, spec);
  assert.deepEqual(await readTemplate(database, "org-a", "tpl-1"), created);
  assert.equal(await readTemplate(database, "org-b", "tpl-1"), null);

  await assert.rejects(
    insertTemplate(database, { id: "tpl-dup", organizationId: "org-a", name: "默认门面", spec, createdBy: "alice", now: AT }),
    code("EVENT_SITE_TEMPLATE_NAME_TAKEN"),
  );

  const edited = normalizeSpec({ version: 1, blocks: [] });
  assert.equal(await updateTemplate(database, {
    templateId: "tpl-1", organizationId: "org-a", name: "门面 v2", spec: edited, expectedRevision: 1, now: LATER,
  }), 2);
  assert.equal(await updateTemplate(database, {
    templateId: "tpl-1", organizationId: "org-a", name: "门面 v3", spec: edited, expectedRevision: 1, now: LATER,
  }), null);
  const listed = await listTemplates(database, "org-a");
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.name, "门面 v2");
  assert.deepEqual(listed[0]?.spec, edited);

  assert.equal(await deleteTemplate(database, "org-b", "tpl-1"), false);
  assert.equal(await deleteTemplate(database, "org-a", "tpl-1"), true);
  assert.equal(await readTemplate(database, "org-a", "tpl-1"), null);
});

/* ------------------------------------------------------------------ *
 * 落库前过 serializeSpec：128KB 是 413
 * ------------------------------------------------------------------ */

test("落库前先 serializeSpec：超过 128KB 的规格是 413，且不会写进库", async () => {
  const event = await makeEvent();
  const huge = { version: 1, blocks: [{ kind: "richText", id: "r1", variant: "prose", priority: 3, collapse: false, text: "字".repeat(140000) }] } as unknown as EventSitePageSpec;
  await assert.rejects(
    createPage(database, event, { id: "page-huge", organizationId: "org-a", shortCode: "HUGE123456789012", spec: huge, now: AT }),
    (error: unknown) => error instanceof DomainError && error.code === "EVENT_SITE_SPEC_TOO_LARGE" && error.status === 413,
  );
  assert.equal(await readPage(database, event), null);

  const { eventId: existing } = await newPage();
  await assert.rejects(
    saveDraft(database, existing, { spec: huge, expectedRevision: 1, now: LATER }),
    (error: unknown) => error instanceof DomainError && error.code === "EVENT_SITE_SPEC_TOO_LARGE" && error.status === 413,
  );
  assert.equal((await readPage(database, existing))?.revision, 1);
});

/* ------------------------------------------------------------------ *
 * 只读清点
 * ------------------------------------------------------------------ */

test("清点只读且按机构隔离：机构只看到自己的，平台能看全部", async () => {
  const mine = await newPage();
  const other = await makeEvent();
  await createPage(database, other, {
    id: "page-other", organizationId: "org-a", shortCode: "OTHER12345678901", spec: defaultSpec(), now: AT,
  });
  const organizationPages = await listOrganizationPages(database, "org-a", 50);
  assert.ok(organizationPages.some(page => page.eventId === mine.eventId));
  assert.deepEqual(await listOrganizationPages(database, "org-b", 50), []);
  const all = await listAllPages(database, 50);
  assert.ok(all.length >= organizationPages.length);
  assert.ok(all.every(page => typeof page.shortCode === "string"));
});
