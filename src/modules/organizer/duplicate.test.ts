/**
 * P05 · 复制赛事与配置复用：**纯逻辑**验收（无 IO、无数据库）。
 *
 * 覆盖 P05 第 6 节的可离线断言项；需要真实事务的部分（跨机构拒绝、并发版本冲突、
 * 事务回滚不新增赛事）由主会话的根集成 / 路由验收承担，见交付文档。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../../shared/errors.ts";
import { ORGANIZER_TEMPLATES } from "./templates.ts";
import type { EventModuleFlags } from "../../shared/organizer-contracts.ts";
import type { EventTemplate, HostedEvent } from "./model.ts";
import {
  DUPLICATE_TITLE_SUFFIX, assertTemplateCompatible, duplicateComparison, duplicateEventIdentity,
  duplicateFormInput, duplicateJudgingConfigInput, duplicateSourceHint, duplicateTitle, mergeConfiguration, parseDuplicateRequest, shiftedOccurrenceTimes,
} from "./duplicate.ts";

const ONLINE = ORGANIZER_TEMPLATES.find(template => template.key === "online")!;
const ONSITE = ORGANIZER_TEMPLATES.find(template => template.key === "onsite")!;
/** 固定"现在"，让平移结果可断言（本模块不读时钟，时间一律由调用方传入）。 */
const NOW = "2026-10-16T00:00:00.000Z";
const TEST_NOW = new Date(NOW);

function modules(overrides: Partial<EventModuleFlags> = {}): EventModuleFlags {
  return { registration: true, teams: true, icebreaking: false, judging: true, schedule: true, accommodation: false, mealVouchers: false, ...overrides };
}

function sourceEvent(overrides: Partial<HostedEvent> = {}): HostedEvent {
  return {
    organizationId: "org-a", organizationName: "测试机构甲", eventId: "event-source",
    title: "2026 校园 AI 黑客松", status: "published", revision: 7, publishedRevision: 3,
    timezone: "Asia/Shanghai",
    startsAt: "2026-10-20T02:00:00.000Z", endsAt: "2026-10-22T10:00:00.000Z",
    registrationOpensAt: "2026-10-12T02:00:00.000Z", registrationClosesAt: "2026-10-19T10:00:00.000Z",
    submissionClosesAt: "2026-10-22T09:00:00.000Z",
    modules: modules(), registration: { reviewRequired: true, capacity: 42 },
    teams: { mode: "mixed", minSize: 2, maxSize: 6, locksAt: "2026-10-21T02:00:00.000Z" },
    linkedEventId: "discovery-1",
    templateKey: "online", templateVersion: 1, format: "online",
    summary: "面向首次参赛的学生", rules: "公开规则原文", location: "在线参赛入口",
    responsibleUserId: "user-owner", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z",
    ...overrides,
  };
}

const code = (expected: string) => (failure: unknown): boolean => failure instanceof DomainError && failure.code === expected;

/** 复制配置的便捷入口：时间固定用 NOW 平移，便于断言。 */
function copyConfiguration(source: HostedEvent, title = "新一届", template: EventTemplate = ONLINE) {
  return mergeConfiguration(source, template, { title, times: shiftedOccurrenceTimes(source, NOW) }, "org-a");
}

describe("P05 复制赛事 · 排期平移（不沿用上一届的绝对日期）", () => {
  it("开赛时刻平移到当前，结束时刻保持与来源相同的跨度", () => {
    const source = sourceEvent();
    const times = shiftedOccurrenceTimes(source, NOW);
    const sourceSpan = Date.parse(source.endsAt) - Date.parse(source.startsAt);
    assert.equal(times.startsAt, NOW, "开赛应是当前时刻");
    assert.equal(Date.parse(times.endsAt) - Date.parse(times.startsAt), sourceSpan, "跨度（含时长）必须与来源一致");
    assert.notEqual(times.startsAt, source.startsAt, "绝不能沿用上一届的开赛日期");
    assert.notEqual(times.endsAt, source.endsAt, "绝不能沿用上一届的结束日期");
  });

  it("报名窗口、作品截止、队伍锁定相对开赛的位置保持不变", () => {
    const source = sourceEvent();
    const times = shiftedOccurrenceTimes(source, NOW);
    const offset = (value: string) => Date.parse(value) - Date.parse(source.startsAt);
    const shifted = (value: string) => Date.parse(value) - Date.parse(times.startsAt);
    for (const [from, to] of [
      [source.registrationOpensAt!, times.registrationOpensAt!],
      [source.registrationClosesAt!, times.registrationClosesAt!],
      [source.submissionClosesAt!, times.submissionClosesAt!],
      [source.teams.locksAt!, times.locksAt!],
    ] as const) {
      assert.equal(shifted(to), offset(from), "各截止相对开赛的位置必须一致");
      assert.notEqual(to, from, "不得沿用上一届的绝对时间");
    }
  });

  it("来源没有的截止时间，副本同样为空（不凭空补时间）", () => {
    const source = sourceEvent({ registrationOpensAt: null, registrationClosesAt: null, submissionClosesAt: null, teams: { mode: "free", minSize: 1, maxSize: 3, locksAt: null } });
    const times = shiftedOccurrenceTimes(source, NOW);
    assert.equal(times.registrationOpensAt, null);
    assert.equal(times.registrationClosesAt, null);
    assert.equal(times.submissionClosesAt, null);
    assert.equal(times.locksAt, null);
  });

  it("来源时间不完整或过短时明确失败，不产出无法发布的副本", () => {
    assert.throws(() => shiftedOccurrenceTimes(sourceEvent({ startsAt: "not-a-date" }), NOW), code("ORGANIZER_DUPLICATE_SOURCE_INVALID"));
    assert.throws(() => shiftedOccurrenceTimes(sourceEvent({ endsAt: "2026-10-20T02:00:00.000Z" }), NOW), code("ORGANIZER_DUPLICATE_SOURCE_INVALID"));
    assert.throws(() => shiftedOccurrenceTimes(sourceEvent(), "not-a-date"), code("ORGANIZER_DUPLICATE_SOURCE_INVALID"));
  });

  it("平移后的配置能通过既有校验（副本可立即编辑与发布）", () => {
    const source = sourceEvent();
    const times = shiftedOccurrenceTimes(source, NOW);
    assert.ok(Date.parse(times.endsAt) > Date.parse(times.startsAt));
    assert.ok(!times.registrationClosesAt || Date.parse(times.registrationClosesAt) > Date.parse(times.registrationOpensAt!));
    assert.ok(!times.registrationClosesAt || Date.parse(times.registrationClosesAt) <= Date.parse(times.endsAt));
    assert.ok(!times.submissionClosesAt || Date.parse(times.submissionClosesAt) <= Date.parse(times.endsAt));
    assert.ok(!times.submissionClosesAt || Date.parse(times.submissionClosesAt) >= Date.parse(times.startsAt));
    assert.doesNotThrow(() => copyConfiguration(source));
  });
});

describe("P05 复制赛事 · 配置搬运", () => {
  it("复制运行配置，且**五个时间字段都来自平移而不是来源**", () => {
    const source = sourceEvent();
    const configuration = copyConfiguration(source, "新一届");
    assert.equal(configuration.title, "新一届");
    assert.equal(configuration.timezone, "Asia/Shanghai");
    assert.equal(configuration.startsAt, NOW);
    assert.notEqual(configuration.startsAt, source.startsAt);
    assert.notEqual(configuration.endsAt, source.endsAt);
    assert.notEqual(configuration.registrationClosesAt, source.registrationClosesAt);
    assert.notEqual(configuration.submissionClosesAt, source.submissionClosesAt);
    assert.notEqual(configuration.teams.locksAt, source.teams.locksAt);
  });

  it("复制模块开关、报名设置与组队设置", () => {
    const configuration = copyConfiguration(sourceEvent());
    assert.deepEqual(configuration.modules, modules());
    assert.deepEqual(configuration.registration, { reviewRequired: true, capacity: 42 });
    assert.equal(configuration.teams.mode, "mixed");
    assert.equal(configuration.teams.minSize, 2);
    assert.equal(configuration.teams.maxSize, 6);
  });

  it("复制简介、公开规则与地点（内容照抄，发布前仍需确认）", () => {
    const configuration = copyConfiguration(sourceEvent());
    assert.equal(configuration.summary, "面向首次参赛的学生");
    assert.equal(configuration.rules, "公开规则原文");
    assert.equal(configuration.location, "在线参赛入口");
  });

  it("**跨机构来源被拒绝**，不得借复用绕过组织隔离", () => {
    assert.throws(() => mergeConfiguration(sourceEvent({ organizationId: "org-b" }), ONLINE, { title: "新一届", times: shiftedOccurrenceTimes(sourceEvent(), NOW) }, "org-a"),
      code("ORGANIZER_DUPLICATE_FORBIDDEN"));
  });

  it("来源启用现场住宿/餐券时，线上模板被明确拒绝并给出替代路径", () => {
    const source = sourceEvent({ modules: modules({ accommodation: true }) });
    assert.throws(() => assertTemplateCompatible(ONLINE, source.modules), code("ORGANIZER_DUPLICATE_TEMPLATE_INCOMPATIBLE"));
    // 线下模板可以承载同一套模块。
    assert.doesNotThrow(() => assertTemplateCompatible(ONSITE, source.modules));
    assert.throws(() => copyConfiguration(source), code("ORGANIZER_DUPLICATE_TEMPLATE_INCOMPATIBLE"));
  });

  it("配置仍受既有同口径校验约束（队伍上限不得小于下限）", () => {
    const source = sourceEvent({ teams: { mode: "free", minSize: 5, maxSize: 2, locksAt: null } });
    assert.throws(() => copyConfiguration(source), code("ORGANIZER_INPUT_INVALID"));
  });
});

describe("P05 复制赛事 · 新赛事身份", () => {
  const identity = { eventId: "event-copy", organizationId: "org-a", organizationName: "测试机构甲", responsibleUserId: "user-owner", createdAt: "2026-10-16T00:00:00.000Z" };

  it("新赛事是 **draft 且 publishedRevision 为 null**，负责人是当前操作人", () => {
    const source = sourceEvent();
    const copy = duplicateEventIdentity(source, copyConfiguration(source), identity);
    assert.equal(copy.status, "draft");
    assert.equal(copy.publishedRevision, null);
    assert.equal(copy.revision, 1);
    assert.equal(copy.eventId, "event-copy");
    assert.equal(copy.responsibleUserId, "user-owner");
    assert.equal(copy.createdAt, identity.createdAt);
    assert.equal(copy.updatedAt, identity.createdAt);
  });

  it("**不继承 M03 关联**（linkedEventId 必须重新显式设置）", () => {
    const source = sourceEvent({ linkedEventId: "discovery-1" });
    assert.equal(source.linkedEventId, "discovery-1");
    const copy = duplicateEventIdentity(source, copyConfiguration(source), identity);
    assert.equal(copy.linkedEventId, null);
    assert.notEqual(copy.linkedEventId, source.linkedEventId);
  });

  it("沿用来源的形式与模板键，不因复制改变线上/线下属性", () => {
    const source = sourceEvent({ templateKey: "onsite", format: "onsite" });
    const copy = duplicateEventIdentity(source, copyConfiguration(source, "新一届", ONSITE), identity);
    assert.equal(copy.format, "onsite");
    assert.equal(copy.templateKey, "onsite");
    assert.equal(copy.templateVersion, 1);
  });

  it("复制出的草稿可以立刻通过既有发布前校验（时间有效、模块合法）", () => {
    const source = sourceEvent();
    const copy = duplicateEventIdentity(source, copyConfiguration(source), identity);
    assert.ok(Number.isFinite(Date.parse(copy.startsAt)));
    assert.ok(Number.isFinite(Date.parse(copy.endsAt)));
    assert.ok(Date.parse(copy.endsAt) > Date.parse(copy.startsAt));
    assert.equal(copy.publishedRevision, null, "未发布，公开目录里不会出现这场");
  });
});

describe("P05 复制赛事 · 报名表与评审配置", () => {
  it("报名表复制为新赛事的**第一版**（expectedRevision 0），字段原样搬运", () => {
    const fields = [{ id: "f1", type: "text", label: "姓名", description: "", required: true }];
    const input = duplicateFormInput({ title: "报名表", description: "请如实填写", fields }, "2026 校园 AI 黑客松");
    assert.equal(input.expectedRevision, 0);
    assert.equal(input.title, "报名表");
    assert.deepEqual(input.fields, fields);
    assert.match(input.changeNote, /2026 校园 AI 黑客松/, "变更说明要写明来源，便于审计");
  });

  it("来源报名表结构不可用时明确失败，而不是静默产出空表", () => {
    assert.throws(() => duplicateFormInput({ title: "x", description: "", fields: undefined as unknown as readonly unknown[] }, "来源"), code("ORGANIZER_DUPLICATE_FORM_INVALID"));
  });

  it("评审配置复制为新赛事的**第一轮**（expectedRevision 0），并保留申诉时限", () => {
    const criteria = [{ id: "c1", label: "完成度", weight: 60, min: 0, max: 10 }, { id: "c2", label: "创意", weight: 40, min: 0, max: 10 }];
    const input = duplicateJudgingConfigInput({ title: "决赛评审", criteria, minJudges: 3, missingPolicy: "exclude_incomplete", tiePolicy: "manual_order", appealWindowDays: 14 });
    assert.equal(input.expectedRevision, 0);
    assert.equal(input.config.title, "决赛评审");
    assert.equal(input.config.minJudges, 3);
    assert.equal(input.config.missingPolicy, "exclude_incomplete");
    assert.equal(input.config.tiePolicy, "manual_order");
    assert.equal(input.config.appealWindowDays, 14);
    assert.deepEqual(input.config.criteria, criteria);
  });

  it("来源尚未配置评审标准时明确失败，不编造默认维度", () => {
    assert.throws(() => duplicateJudgingConfigInput({ criteria: [] }), code("ORGANIZER_DUPLICATE_JUDGING_INVALID"));
    assert.throws(() => duplicateJudgingConfigInput({ title: "只有名字" }), code("ORGANIZER_DUPLICATE_JUDGING_INVALID"));
  });
});

describe("P05 复制赛事 · 名称、对照表与输入解析", () => {
  it("默认名称为「<原名>（副本）」", () => {
    assert.equal(duplicateTitle("2026 校园 AI 黑客松", []), `2026 校园 AI 黑客松${DUPLICATE_TITLE_SUFFIX}`);
  });

  it("同名已存在时追加序号，不产生两个同名副本", () => {
    const taken = [`比赛${DUPLICATE_TITLE_SUFFIX}`, `比赛${DUPLICATE_TITLE_SUFFIX} 2`];
    assert.equal(duplicateTitle("比赛", taken), `比赛${DUPLICATE_TITLE_SUFFIX} 3`);
  });

  it("对照表把「不予复制」的事实逐条列出（时间、关联、发布、答卷、队伍、通知、评审事实、申诉）", () => {
    const plan = duplicateComparison(sourceEvent(), { includeRegistrationForm: true, includeJudgingConfig: true });
    for (const key of ["times", "linkedEventId", "publication", "answers", "roster", "notices", "judgingData", "appeals"]) {
      assert.ok(plan.skipped.includes(key), `${key} 应明确列为不复制`);
    }
    for (const key of ["title", "timezone", "modules", "registration", "teams", "content", "location", "format", "form", "judgingConfig"]) {
      assert.ok(plan.copied.includes(key), `${key} 应列为复制`);
    }
    assert.ok(plan.items.every(item => item.note.length > 0), "每一条都要给出理由");
  });

  it("选择不复制配置项时，对照表相应转为「不复制」并说明原因", () => {
    const plan = duplicateComparison(sourceEvent(), { includeRegistrationForm: false, includeJudgingConfig: false });
    assert.ok(plan.skipped.includes("form"));
    assert.ok(plan.skipped.includes("judgingConfig"));
    assert.ok(!plan.copied.includes("form"));
  });

  it("对照表不出现完成度、百分比或推荐措辞", () => {
    const plan = duplicateComparison(sourceEvent(), { includeRegistrationForm: true, includeJudgingConfig: true });
    const text = plan.items.map(item => `${item.label}${item.note}`).join("");
    for (const banned of ["完成度", "百分比", "推荐", "最佳", "一键", "进度"]) {
      assert.ok(!text.includes(banned), `对照表不得出现「${banned}」`);
    }
  });

  it("输入解析：缺省复制两项配置，非法类型被拒绝", () => {
    const parsed = parseDuplicateRequest({ expectedOrganizationRevision: 5 });
    assert.equal(parsed.title, undefined);
    assert.equal(parsed.includeRegistrationForm, true);
    assert.equal(parsed.includeJudgingConfig, true);
    assert.equal(parsed.expectedOrganizationRevision, 5);
    assert.equal(parseDuplicateRequest({ expectedOrganizationRevision: 5, includeJudgingConfig: false }).includeJudgingConfig, false);
    assert.throws(() => parseDuplicateRequest({ expectedOrganizationRevision: 5, includeJudgingConfig: "yes" }), code("ORGANIZER_INPUT_INVALID"));
    assert.throws(() => parseDuplicateRequest({ expectedOrganizationRevision: 0 }), code("ORGANIZER_INPUT_INVALID"));
    assert.throws(() => parseDuplicateRequest({ expectedOrganizationRevision: 1, unknownField: 1 }), code("ORGANIZER_INPUT_INVALID"));
  });

  it("归档来源允许复制，但必须给出「配置可能过时」的提示", () => {
    assert.equal(duplicateSourceHint(sourceEvent({ status: "draft" })), null);
    assert.equal(duplicateSourceHint(sourceEvent({ status: "published" })), null);
    assert.match(duplicateSourceHint(sourceEvent({ status: "archived" })) ?? "", /已归档/);
  });

  it("接受 draft / published / ended / archived 四种来源状态；形式沿用来源", () => {
    for (const status of ["draft", "published", "ended", "archived"] as const) {
      const source = sourceEvent({ status });
      assert.doesNotThrow(() => copyConfiguration(source, "副本"), `来源状态 ${status} 应可复制`);
    }
  });
});

describe("P05 复制赛事 · 不复制运行数据（结构性保证）", () => {
  const identity = { eventId: "event-copy", organizationId: "org-a", organizationName: "测试机构甲", responsibleUserId: "user-owner", createdAt: "2026-10-16T00:00:00.000Z" };

  it("复制结果的字段集里不存在答卷、队伍、通知、评分与申诉", () => {
    const source = sourceEvent();
    const copy = duplicateEventIdentity(source, copyConfiguration(source), identity);
    const forbidden = ["answers", "registrations", "roster", "rosterTeams", "notifications", "readReceipts", "rounds", "assignments", "scores", "appeals", "audits", "publishedResults", "intakeReceipts"];
    for (const key of forbidden) {
      assert.ok(!Object.hasOwn(copy, key), `新赛事不得带上 ${key}`);
    }
  });

  it("来源对象在复制过程中逐字段不变", () => {
    const source = sourceEvent();
    const before = structuredClone(source);
    const configuration = copyConfiguration(source);
    duplicateEventIdentity(source, configuration, identity);
    duplicateComparison(source, { includeRegistrationForm: true, includeJudgingConfig: true });
    shiftedOccurrenceTimes(source, NOW);
    assert.deepEqual(source, before, "复制不得改写来源赛事");
  });

  it("模板对象不被复制过程改写", () => {
    const before = structuredClone(ONLINE);
    copyConfiguration(sourceEvent());
    assert.deepEqual(ONLINE, before);
  });
});
