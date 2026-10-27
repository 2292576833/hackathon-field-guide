import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../shared/errors.ts";
import type { ClosureIntakeReceipt, ClosurePublishedResult, ClosureReuseSource, ContactWillingness } from "./model.ts";
import {
  activeWillingness, contactWillingnessChoice, contactWillingnessConsentNotice, contactWillingnessIdempotencyKey,
  contactWillingnessPrivacyNotice, contactWillingnessRevision, contactWillingnessTeamId, contactWillingnessWithdrawNotice,
  myContactWillingnessView, organizerContactWillingness, postEventSummary, reuseSourcesOf,
} from "./policy.ts";

const failure = (code: string) => (error: unknown): boolean => error instanceof DomainError && error.code === code;

const willingness = (overrides: Partial<ContactWillingness> = {}): ContactWillingness => ({
  id: "w-1", organizationId: "org", eventId: "event-a", teamId: "team-a", authorUserId: "alice", willing: true,
  status: "active", revision: 1, submittedAt: "2026-10-16T00:00:00.000Z", withdrawnAt: null, idempotencyKey: "key-1", ...overrides,
});

const receipt = (overrides: Partial<ClosureIntakeReceipt> = {}): ClosureIntakeReceipt => ({
  id: "receipt-1", teamId: "team-a", version: 1, receiptNumber: "REC-1", ruleVersion: 1, eventRevision: 1,
  submittedAt: "2026-10-15T00:00:00.000Z", memberUserIds: ["alice"], ...overrides,
});

const published = (overrides: Partial<ClosurePublishedResult> = {}): ClosurePublishedResult => ({
  id: "result-1", roundId: "round-1", roundTitle: "决赛", version: 2, visibility: "public",
  publishedAt: "2026-10-15T12:00:00.000Z", reviewRequired: false,
  rows: [{ teamId: "team-a", title: "作品甲", total: 80, rank: 1, approvedFeedbackCount: 1 }], ...overrides,
});

const event = { eventId: "event-a", organizationId: "org", title: "测试比赛", status: "ended" as const, timezone: "Asia/Shanghai",
  startsAt: "2026-10-14T00:00:00.000Z", endsAt: "2026-10-15T00:00:00.000Z", submissionClosesAt: "2026-10-14T12:00:00.000Z", afterEvent: true };
const retrospectives = { confirmedCount: null, linkedProjectCount: 0, state: "unread" as const, notice: "尚未接入复盘读取，这里不显示 0。" };

test("同意口径原文写明只表示同意被联系，不代表投资、录用或孵化机会", () => {
  assert.match(contactWillingnessConsentNotice, /只表示同意/);
  assert.match(contactWillingnessConsentNotice, /不代表/);
  for (const word of ["投资", "录用", "孵化"]) assert.ok(contactWillingnessConsentNotice.includes(word), `同意口径缺少"${word}"`);
  // 不得出现任何"机会保证"式表述。
  assert.doesNotMatch(contactWillingnessConsentNotice, /保证获得|承诺录用|承诺投资|一定/);
  assert.match(contactWillingnessPrivacyNotice, /默认不公开/);
  assert.match(contactWillingnessWithdrawNotice, /撤回/);
});

test("选择必须是明确布尔值，重试标识与版本有界", () => {
  assert.equal(contactWillingnessChoice(true), true);
  assert.equal(contactWillingnessChoice(false), false);
  for (const invalid of ["yes", "true", 1, 0, null, undefined]) assert.throws(() => contactWillingnessChoice(invalid), failure("CLOSURE_INVALID_INPUT"));
  assert.equal(contactWillingnessTeamId(" team-a "), "team-a");
  assert.throws(() => contactWillingnessTeamId(""), failure("CLOSURE_INVALID_INPUT"));
  assert.equal(contactWillingnessIdempotencyKey("key-1"), "key-1");
  assert.throws(() => contactWillingnessIdempotencyKey("x".repeat(121)), failure("CLOSURE_INVALID_INPUT"));
  assert.equal(contactWillingnessRevision(3), 3);
  for (const invalid of [0, -1, 1.5, "1"]) assert.throws(() => contactWillingnessRevision(invalid), failure("CLOSURE_INVALID_INPUT"));
});

test("主办方只看到主动选择愿意的队伍，未选择、撤回与选择不愿意都不出现", () => {
  const items = organizerContactWillingness([
    willingness({ id: "w-a", teamId: "team-c" }),
    willingness({ id: "w-b", teamId: "team-a" }),
    willingness({ id: "w-c", teamId: "team-b", willing: false }),
    willingness({ id: "w-d", teamId: "team-d", status: "withdrawn" }),
  ]);
  assert.deepEqual(items.map(item => item.teamId), ["team-a", "team-c"]);
  assert.equal(items[0]!.chosenAt, "2026-10-16T00:00:00.000Z");
  assert.equal((items[0] as unknown as Record<string, unknown>).authorUserId, undefined, "不得暴露提交人账号");
});

test("本队视图只含本队历史，并指回既有赛后清单与复盘入口", () => {
  const view = myContactWillingnessView({ eventId: "event-a", teamId: "team-a", memberCount: 2, projectId: "project-a", records: [
    willingness({ id: "w-old", status: "withdrawn", withdrawnAt: "2026-10-16T01:00:00.000Z", submittedAt: "2026-10-15T00:00:00.000Z" }),
    willingness({ id: "w-new", submittedAt: "2026-10-16T02:00:00.000Z" }),
    willingness({ id: "w-other", teamId: "team-b" }),
  ] });
  assert.equal(view.active?.id, "w-new");
  assert.deepEqual(view.history.map(item => item.id), ["w-new", "w-old"], "按提交时间倒序，且不含其他队伍");
  assert.equal(view.reuse.myChecklistsHref, "/competitions/event-a/my-checklists?teamId=team-a");
  assert.equal(view.reuse.retrospectiveHref, "/projects/project-a/retrospectives");
  assert.equal(view.consentNotice, contactWillingnessConsentNotice);
  const noProject = myContactWillingnessView({ eventId: "event-a", teamId: "team-a", memberCount: 1, projectId: null, records: [] });
  assert.equal(noProject.active, null);
  assert.equal(noProject.reuse.retrospectiveHref, null, "没有关联团队空间时不编造复盘入口");
});

test("赛后成果清单只列已公布内容：未公布作品不出现，需复核的作品不列作品与反馈", () => {
  const summary = postEventSummary({ event, receipts: [receipt({ id: "receipt-1" }), receipt({ id: "receipt-2", teamId: "team-b", version: 2, submittedAt: "2026-10-15T06:00:00.000Z" })],
    published: [published(), published({ id: "result-2", roundId: "round-2", roundTitle: "复赛", version: 3, reviewRequired: true })],
    reuse: [], retrospectives, willingness: [willingness()] });
  assert.equal(summary.outcomes.intake.count, 2);
  assert.equal(summary.outcomes.intake.latestSubmittedAt, "2026-10-15T06:00:00.000Z");
  assert.equal(summary.outcomes.published.length, 2);
  // 版本降序：v3（需复核）在前。
  assert.deepEqual(summary.outcomes.published.map(item => item.version), [3, 2]);
  const reviewed = summary.outcomes.published[0]!;
  assert.equal(reviewed.reviewRequired, true);
  assert.deepEqual(reviewed.works, [], "需复核时不列出任何作品");
  assert.equal(reviewed.approvedFeedbackCount, 0, "需复核时不导出已批准反馈计数");
  const live = summary.outcomes.published[1]!;
  assert.deepEqual(live.works, [{ teamId: "team-a", title: "作品甲" }]);
  assert.equal(live.approvedFeedbackCount, 1);
  assert.equal(summary.outcomes.retrospectives.confirmedCount, null, "未接入复盘读取时是 null，不是 0");
  assert.equal(summary.contactWillingness.length, 1);
  assert.equal(summary.existingQueues.length, 3, "下一步只指回既有队列");
  assert.ok(summary.existingQueues.every(queue => queue.href.includes("event-a")));
});

test("下一届可复用只保留已公布/已批准且指回既有记录的条目", () => {
  const sources: ClosureReuseSource[] = [
    { id: "form", kind: "registration_form", label: "报名表单字段", detail: "已发布的报名表", href: "/organizer/events/event-a/registration-form", state: "published" },
    { id: "draft", kind: "notification_template", label: "通知模板草稿", detail: "未批准", href: "/x", state: "draft" },
    { id: "unpublished", kind: "branding", label: "品牌配置", detail: "还没发布", href: "/y", state: "unpublished" },
    { id: "empty", kind: "schedule", label: "时间表", detail: "缺少指回路径", href: "  ", state: "approved" },
    { id: "form", kind: "registration_form", label: "重复条目", detail: "去重", href: "/z", state: "published" },
    { id: "judging", kind: "judging_baseline", label: "评审基准版本", detail: "已锁定并公布", href: "/organizer/events/event-a/judging/config", state: "approved" },
  ];
  const kept = reuseSourcesOf(sources);
  assert.deepEqual(kept.map(item => item.id), ["judging", "form"], "按 kind 稳定排序，丢弃草稿/未发布/无指针/重复");
  const summary = postEventSummary({ event, receipts: [], published: [], reuse: sources, retrospectives, willingness: [] });
  assert.deepEqual(summary.reuse.map(item => item.id), ["judging", "form"]);
});

test("activeWillingness 只认本队当前有效的那条", () => {
  assert.equal(activeWillingness([willingness({ id: "w-1" }), willingness({ id: "w-2", teamId: "team-b" })], "team-a")?.id, "w-1");
  assert.equal(activeWillingness([willingness({ status: "withdrawn" })], "team-a"), null);
  assert.equal(activeWillingness([willingness({ teamId: "team-b" })], "team-a"), null);
});
