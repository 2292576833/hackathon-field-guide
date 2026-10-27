/**
 * P05 · 复制赛事与配置复用：**服务编排与事务验收**（真实 PGlite，仅隔离内存实例）。
 *
 * 报名表与评审配置跨模块，按模块边界用注入 Port 验证编排（真实适配由根注入，见交付文档 NEEDS_INTERFACE）；
 * 组织、赛事、发布版本与审计走真实 SQL，因此"来源不变""事务回滚""单一路径"这几项
 * 是在真实持久层上断言的，而不是靠桩。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { SqlExecutor } from "../../shared/persistence.ts";
import { organizerError, organizerFixture } from "./testing.ts";
import type { OrganizerJudgingConfigPort, OrganizerRegistrationFormPort } from "./service.ts";

const code = (expected: string) => organizerError(expected);
const FORM = { title: "报名表", description: "请如实填写", fields: [{ id: "f1", type: "text", label: "姓名", description: "", required: true }] };
const CONFIG = { title: "决赛评审", criteria: [{ id: "c1", label: "完成度", weight: 100, min: 0, max: 10 }], minJudges: 2, missingPolicy: "block_publication", tiePolicy: "shared_rank", appealWindowDays: 14 };

/** 记录每次调用的执行器与入参，用来断言"同事务、同执行器、单一路径"。 */
function registrationRecorder(form: { title: string; description: string; fields: readonly unknown[] } | null) {
  const calls: { sql: SqlExecutor; eventId: string; input: unknown }[] = [];
  return {
    calls,
    port: {
      async getForm(_sql: SqlExecutor, _eventId: string) { return form ? { ...form } : null; },
      async saveForm(sql: SqlExecutor, _principal: unknown, eventId: string, input: unknown) { calls.push({ sql, eventId, input }); return input; },
    } satisfies OrganizerRegistrationFormPort,
  };
}
function judgingRecorder(config: Record<string, unknown> | null) {
  const calls: { sql: SqlExecutor; eventId: string; input: unknown }[] = [];
  return {
    calls,
    port: {
      async getConfig(_sql: SqlExecutor, _eventId: string) { return config ? structuredClone(config) : null; },
      async saveConfig(sql: SqlExecutor, _principal: unknown, eventId: string, input: unknown) { calls.push({ sql, eventId, input }); return input; },
    } satisfies OrganizerJudgingConfigPort,
  };
}

type Fixture = Awaited<ReturnType<typeof organizerFixture>>;
type Options = Parameters<typeof organizerFixture>[1];

/** 建立"机构 + 一场已发布赛事"的基线，并保存被复制前的来源快照。 */
async function baseline(t: TestContext, options: Options = {}) {
  const fixture = await organizerFixture(t, options);
  const { organization } = await fixture.approvedOrganization();
  const source = await fixture.createEvent(organization.id, fixture.users.ownerA);
  const published = await fixture.publish(source, fixture.users.ownerA);
  const [row] = (await fixture.direct.query<{ document: Record<string, unknown> }>(
    "SELECT document FROM organizer_hosted_events WHERE id=$1", [published.eventId])).rows;
  const state = {
    fixture, organizationId: organization.id, sourceEventId: published.eventId,
    sourceBefore: structuredClone(row!.document),
    async revision(): Promise<number> {
      const [current] = (await fixture.direct.query<{ revision: number }>(
        "SELECT revision FROM organizer_organizations WHERE id=$1", [organization.id])).rows;
      return current!.revision;
    },
  };
  return state;
}

describe("P05 服务编排 · 复制产出草稿并复用既有创建路径", () => {
  it("复制出 draft 草稿：publishedRevision 为 null、名称默认加「（副本）」、负责人是操作人", async t => {
    const { fixture, sourceEventId, revision } = await baseline(t);
    const result = await fixture.service.duplicateEvent(fixture.users.ownerA, sourceEventId, { expectedOrganizationRevision: await revision() });
    assert.equal(result.event.status, "draft");
    assert.equal(result.event.publishedRevision, null);
    assert.equal(result.event.revision, 1);
    assert.match(result.event.title, /（副本）$/);
    assert.equal(result.event.responsibleUserId, "ownerA");
    const managed = await fixture.service.getManagedEvent(fixture.users.ownerA, result.event.eventId);
    assert.equal(managed.eventId, result.event.eventId);
  });

  it("名称可由调用方指定，且连续自动命名不会重复", async t => {
    const { fixture, sourceEventId, revision } = await baseline(t);
    const named = await fixture.service.duplicateEvent(fixture.users.ownerA, sourceEventId, { title: "第二届", expectedOrganizationRevision: await revision() });
    assert.equal(named.event.title, "第二届");
    const first = await fixture.service.duplicateEvent(fixture.users.ownerA, sourceEventId, { expectedOrganizationRevision: await revision() });
    const second = await fixture.service.duplicateEvent(fixture.users.ownerA, sourceEventId, { expectedOrganizationRevision: await revision() });
    assert.notEqual(first.event.title, second.event.title);
  });

  it("**来源赛事在复制后逐字段不变**，且仍保持已发布状态", async t => {
    const { fixture, sourceEventId, sourceBefore, revision } = await baseline(t);
    await fixture.service.duplicateEvent(fixture.users.ownerA, sourceEventId, { expectedOrganizationRevision: await revision() });
    const [after] = (await fixture.direct.query<{ document: Record<string, unknown>; status: string; published_revision: number }>(
      "SELECT document,status,published_revision FROM organizer_hosted_events WHERE id=$1", [sourceEventId])).rows;
    assert.deepEqual(after!.document, sourceBefore);
    assert.equal(after!.status, "published");
    assert.equal(after!.published_revision, 1);
  });

  it("**时间不沿用上一届的绝对日期**，但各截止相对开赛的位置保持不变", async t => {
    const { fixture, sourceEventId, sourceBefore, revision } = await baseline(t);
    const result = await fixture.service.duplicateEvent(fixture.users.ownerA, sourceEventId, { expectedOrganizationRevision: await revision() });
    const copy = result.event as unknown as Record<string, unknown>;
    for (const key of ["startsAt", "endsAt", "registrationClosesAt", "submissionClosesAt"]) {
      assert.notEqual(copy[key], sourceBefore[key], `${key} 不得沿用来源的绝对时间`);
    }
    const span = (event: Record<string, unknown>) => Date.parse(String(event.endsAt)) - Date.parse(String(event.startsAt));
    assert.equal(span(copy), span(sourceBefore));
    const relative = (event: Record<string, unknown>, key: string) => Date.parse(String(event[key])) - Date.parse(String(event.startsAt));
    for (const key of ["registrationClosesAt", "submissionClosesAt"]) {
      assert.equal(relative(copy, key), relative(sourceBefore, key), `${key} 相对开赛的位置必须一致`);
    }
  });

  it("**不继承 M03 关联**", async t => {
    const { fixture, sourceEventId, revision } = await baseline(t);
    const result = await fixture.service.duplicateEvent(fixture.users.ownerA, sourceEventId, { expectedOrganizationRevision: await revision() });
    assert.equal(result.event.linkedEventId, null);
  });

  it("复制出的草稿可独立编辑，且不影响来源", async t => {
    const { fixture, sourceEventId, sourceBefore, revision } = await baseline(t);
    const result = await fixture.service.duplicateEvent(fixture.users.ownerA, sourceEventId, { expectedOrganizationRevision: await revision() });
    const event = result.event;
    const updated = await fixture.service.updateEvent(fixture.users.ownerA, event.eventId, {
      expectedRevision: event.revision, title: "改名后的副本", timezone: event.timezone,
      startsAt: event.startsAt, endsAt: event.endsAt,
      registrationOpensAt: event.registrationOpensAt, registrationClosesAt: event.registrationClosesAt,
      submissionClosesAt: event.submissionClosesAt, modules: event.modules,
      registration: event.registration, teams: event.teams,
      summary: event.summary, rules: event.rules, location: event.location,
    });
    assert.equal(updated.title, "改名后的副本");
    assert.equal(updated.revision, 2);
    const [source] = (await fixture.direct.query<{ document: Record<string, unknown> }>(
      "SELECT document FROM organizer_hosted_events WHERE id=$1", [sourceEventId])).rows;
    assert.deepEqual(source!.document, sourceBefore);
  });
});

describe("P05 服务编排 · 权限与并发", () => {
  it("**跨机构来源被拒绝**，且不产生任何副本", async t => {
    const { fixture, sourceEventId } = await baseline(t);
    const other = await fixture.approvedOrganization("ownerB");
    const before = await fixture.counts();
    await assert.rejects(
      () => fixture.service.duplicateEvent(fixture.users.ownerB, sourceEventId, { expectedOrganizationRevision: other.organization.revision }),
      (failure: unknown) => code("ORGANIZER_FORBIDDEN")(failure) || code("ORGANIZER_NOT_FOUND")(failure),
    );
    assert.equal((await fixture.counts()).organizer_hosted_events, before.organizer_hosted_events);
  });

  it("与本机构无关的账号不能复制", async t => {
    const { fixture, sourceEventId, revision } = await baseline(t);
    const before = await fixture.counts();
    const expected = await revision();
    await assert.rejects(
      () => fixture.service.duplicateEvent(fixture.users.outsider, sourceEventId, { expectedOrganizationRevision: expected }),
      (failure: unknown) => code("ORGANIZER_FORBIDDEN")(failure) || code("ORGANIZER_NOT_FOUND")(failure),
    );
    assert.equal((await fixture.counts()).organizer_hosted_events, before.organizer_hosted_events);
  });

  it("有本场其他权限但没有 event_manage 的同事不能复制", async t => {
    const { fixture, sourceEventId, organizationId, revision } = await baseline(t);
    await fixture.service.grantStaff(fixture.users.ownerA, organizationId, {
      expectedOrganizationRevision: await revision(), userId: "staff", eventId: sourceEventId,
      role: "staff", capabilities: ["registration_manage"],
    });
    const expected = await revision();
    await assert.rejects(
      () => fixture.service.duplicateEvent(fixture.users.staff, sourceEventId, { expectedOrganizationRevision: expected }),
      code("ORGANIZER_FORBIDDEN"),
    );
  });

  it("**过期的 expectedOrganizationRevision 返回版本冲突**，不新增赛事且不覆盖输入", async t => {
    const { fixture, sourceEventId, revision } = await baseline(t);
    const stale = await revision();
    await fixture.service.duplicateEvent(fixture.users.ownerA, sourceEventId, { title: "第一份", expectedOrganizationRevision: stale });
    const before = await fixture.counts();
    await assert.rejects(
      () => fixture.service.duplicateEvent(fixture.users.ownerA, sourceEventId, { title: "我的输入", expectedOrganizationRevision: stale }),
      (failure: unknown) => {
        assert.ok(code("ORGANIZER_REVISION_CONFLICT")(failure));
        assert.equal(typeof (failure as { latestRevision?: number }).latestRevision, "number");
        return true;
      },
    );
    assert.equal((await fixture.counts()).organizer_hosted_events, before.organizer_hosted_events);
  });
});

describe("P05 服务编排 · 跨模块配置复制与失败回滚", () => {
  it("同一事务、同一执行器：报名表与评审配置都写到**新赛事**，且都是第一版", async t => {
    const forms = registrationRecorder(FORM), judging = judgingRecorder(CONFIG);
    const { fixture, sourceEventId, revision } = await baseline(t, { registrationForms: forms.port, judgingConfig: judging.port });
    const result = await fixture.service.duplicateEvent(fixture.users.ownerA, sourceEventId, { expectedOrganizationRevision: await revision() });
    assert.equal(forms.calls.length, 1);
    assert.equal(judging.calls.length, 1);
    assert.equal(forms.calls[0]!.eventId, result.event.eventId);
    assert.equal(judging.calls[0]!.eventId, result.event.eventId);
    const formInput = forms.calls[0]!.input as { expectedRevision: number; title: string; changeNote: string };
    assert.equal(formInput.expectedRevision, 0);
    assert.equal(formInput.title, FORM.title);
    assert.match(formInput.changeNote, /测试线上赛/);
    const configInput = judging.calls[0]!.input as { expectedRevision: number; config: Record<string, unknown> };
    assert.equal(configInput.expectedRevision, 0);
    assert.equal(configInput.config.appealWindowDays, 14);
    assert.equal(forms.calls[0]!.sql, judging.calls[0]!.sql, "两个 Port 必须复用同一个事务执行器");
  });

  it("**报名表保存失败时整体回滚**：不新增赛事、不写审计、不继续写评审配置", async t => {
    const forms = registrationRecorder(FORM), judging = judgingRecorder(CONFIG);
    const failing: OrganizerRegistrationFormPort = {
      async getForm() { return { ...FORM }; },
      async saveForm() { throw new Error("registration save failed"); },
    };
    const { fixture, sourceEventId, revision } = await baseline(t, { registrationForms: failing, judgingConfig: judging.port });
    const before = await fixture.counts();
    const expected = await revision();
    await assert.rejects(() => fixture.service.duplicateEvent(fixture.users.ownerA, sourceEventId, { expectedOrganizationRevision: expected }));
    const after = await fixture.counts();
    assert.equal(after.organizer_hosted_events, before.organizer_hosted_events, "失败不得留下半成品副本");
    assert.equal(after.organizer_audit_events, before.organizer_audit_events, "回滚要连审计一起退回");
    assert.equal(judging.calls.length, 0);
    assert.ok(forms.calls.length === 0 || forms.calls.length === 1, "报名表调用可能已发生，但必须已回滚");
  });

  it("**评审配置保存失败时整体回滚**：已写入的赛事与机构版本一并退回", async t => {
    const forms = registrationRecorder(FORM);
    const failingJudging: OrganizerJudgingConfigPort = {
      async getConfig() { return structuredClone(CONFIG); },
      async saveConfig() { throw new Error("judging save failed"); },
    };
    const { fixture, sourceEventId, revision } = await baseline(t, { registrationForms: forms.port, judgingConfig: failingJudging });
    const before = await fixture.counts();
    const revisionBefore = await revision();
    await assert.rejects(() => fixture.service.duplicateEvent(fixture.users.ownerA, sourceEventId, { expectedOrganizationRevision: revisionBefore }));
    const after = await fixture.counts();
    assert.equal(after.organizer_hosted_events, before.organizer_hosted_events);
    assert.equal(after.organizer_publication_changes, before.organizer_publication_changes);
    assert.equal(await revision(), revisionBefore, "机构版本也必须回滚");  });

  it("来源尚未配置报名表/评审标准时如实跳过并说明原因，赛事仍建成草稿", async t => {
    const forms = registrationRecorder(null), judging = judgingRecorder(null);
    const { fixture, sourceEventId, revision } = await baseline(t, { registrationForms: forms.port, judgingConfig: judging.port });
    const result = await fixture.service.duplicateEvent(fixture.users.ownerA, sourceEventId, { expectedOrganizationRevision: await revision() });
    assert.equal(result.event.status, "draft");
    assert.match(result.skipped.registrationForm ?? "", /没有可复制/);
    assert.match(result.skipped.judgingConfig ?? "", /没有可复制/);
    assert.equal(forms.calls.length, 0);
    assert.equal(judging.calls.length, 0);
  });

  it("根未注入 Port 时明确登记「未接入」，而不是静默成功", async t => {
    const { fixture, sourceEventId, revision } = await baseline(t);
    const result = await fixture.service.duplicateEvent(fixture.users.ownerA, sourceEventId, { expectedOrganizationRevision: await revision() });
    assert.match(result.skipped.registrationForm ?? "", /未接入/);
    assert.match(result.skipped.judgingConfig ?? "", /未接入/);
  });

  it("可以只复制其中一项配置", async t => {
    const forms = registrationRecorder(FORM), judging = judgingRecorder(CONFIG);
    const { fixture, sourceEventId, revision } = await baseline(t, { registrationForms: forms.port, judgingConfig: judging.port });
    const expected = await revision();
    await fixture.service.duplicateEvent(fixture.users.ownerA, sourceEventId, { includeJudgingConfig: false, expectedOrganizationRevision: expected });
    assert.equal(forms.calls.length, 1);
    assert.equal(judging.calls.length, 0);
  });

  it("来源未启用报名与评审模块时，不去触碰对应 Port", async t => {
    const forms = registrationRecorder(FORM), judging = judgingRecorder(CONFIG);
    const { fixture, organizationId, revision } = await baseline(t, { registrationForms: forms.port, judgingConfig: judging.port });
    // 建一场"只有规则"的比赛（关闭报名与评审）再复制它。
    const rulesOnly = await fixture.createEvent(organizationId, fixture.users.ownerA, "只有规则的比赛", {
      registrationOpensAt: null, registrationClosesAt: null, submissionClosesAt: null,
      modules: { registration: false, teams: false, icebreaking: false, judging: false, schedule: false, accommodation: false, mealVouchers: false },
      registration: { reviewRequired: false, capacity: null }, teams: { mode: "free", minSize: 1, maxSize: 1, locksAt: null },
    });
    assert.equal(rulesOnly.modules.registration, false);
    assert.equal(rulesOnly.modules.judging, false);
    const result = await fixture.service.duplicateEvent(fixture.users.ownerA, rulesOnly.eventId, { expectedOrganizationRevision: await revision() });
    assert.equal(result.event.modules.registration, false, "副本沿用来源的模块开关");
    assert.equal(result.event.modules.judging, false);
    assert.deepEqual(result.skipped, {}, "未启用的模块不应产生「跳过」记录");
    assert.equal(forms.calls.length, 0);
    assert.equal(judging.calls.length, 0);
  });
});

describe("P05 服务编排 · 复制来源列表", () => {
  it("只列本机构中当前身份有 event_manage 的赛事（复用既有 listOrganizationEvents）", async t => {
    const { fixture, sourceEventId, organizationId } = await baseline(t);
    const sources = await fixture.service.listDuplicateSources(fixture.users.ownerA, organizationId);
    assert.ok(sources.some(event => event.eventId === sourceEventId));
    const other = await fixture.approvedOrganization("ownerB");
    const otherEvent = await fixture.createEvent(other.organization.id, fixture.users.ownerB);
    const mine = await fixture.service.listDuplicateSources(fixture.users.ownerA, organizationId);
    assert.ok(!mine.some(event => event.eventId === otherEvent.eventId), "不得列出其他机构的赛事");
  });

  it("在别人的机构上读取来源列表会被拒绝", async t => {
    const { fixture, organizationId } = await baseline(t);
    await fixture.approvedOrganization("ownerB");
    await assert.rejects(
      () => fixture.service.listDuplicateSources(fixture.users.ownerB, organizationId),
      (failure: unknown) => code("ORGANIZER_FORBIDDEN")(failure) || code("ORGANIZER_NOT_FOUND")(failure),
    );
  });

  it("只有部分赛事权限时，不具备 event_manage 的赛事不出现在来源里", async t => {
    const { fixture, organizationId, revision } = await baseline(t);
    const extra = await fixture.createEvent(organizationId, fixture.users.ownerA);
    // 给 staff 一个只看报名的本场权限。
    await fixture.service.grantStaff(fixture.users.ownerA, organizationId, {
      expectedOrganizationRevision: await revision(), userId: "staff", eventId: extra.eventId,
      role: "staff", capabilities: ["registration_manage"],
    });
    const forStaff = await fixture.service.listDuplicateSources(fixture.users.staff, organizationId);
    assert.ok(!forStaff.some(event => event.eventId === extra.eventId), "没有 event_manage 的赛事不得作为复制来源");
  });
});
