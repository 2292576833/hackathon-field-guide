import test from "node:test";
import assert from "node:assert/strict";
import { NoticePublicationAttempt, prepareNoticePublication } from "./publication.ts";
import type { ManagedSelectionNoticeList, PublishSelectionNoticeInput, SelectionNotice, SelectionNoticeTemplate } from "./model.ts";

const registration = { id: "registration-a", userId: "user-a", revision: 4, status: "approved" };
const template: SelectionNoticeTemplate = { eventId: "event-a", revision: 2, subject: "入选 {event}", body: "你好 {name}", accent: "orange", theme: "letter", preview: { subject: "入选 A 赛", body: "你好 参赛者" } };
const managed: ManagedSelectionNoticeList = { items: [], recipient: { userId: "user-a", label: "小橙" }, registrationRevision: 4 };
function receipt(version = 1, patch: Partial<SelectionNotice> = {}): SelectionNotice {
  return { id: "notice-a", eventId: "event-a", registrationId: "registration-a", registrationRevision: 4, version, templateRevision: 2, subject: "入选 A 赛", body: "你好 小橙", accent: "orange", theme: "letter", publishedAt: "2026-10-11T06:00:00Z", mailState: "unconfigured", ...patch };
}
test("预览绑定真实收件人和报名版本，示例姓名明确区分", () => {
  const preview = prepareNoticePublication("event-a", registration, template, managed);
  assert.equal(preview.recipient.label, "小橙"); assert.equal(preview.exampleName, true);
  assert.equal(preview.content.body, "你好 参赛者");
  assert.throws(() => prepareNoticePublication("event-other", registration, template, managed));
  assert.throws(() => prepareNoticePublication("event-a", registration, template, { ...managed, recipient: { userId: "other", label: "他人" } }));
  assert.throws(() => prepareNoticePublication("event-a", registration, template, { ...managed, registrationRevision: 5 }));
});
test("若根提供定向安全预览则只采用同一模板版本", () => {
  const target = { ...managed, preview: { ...receipt(), templateRevision: 2 } };
  assert.equal(prepareNoticePublication("event-a", registration, template, target).exampleName, false);
  assert.throws(() => prepareNoticePublication("event-a", registration, template, { ...target, preview: { ...target.preview, templateRevision: 3 } }));
});
test("同一次发布并发双点只执行一个请求，已成功再次调用返回同回执", async () => {
  const attempt = new NoticePublicationAttempt(prepareNoticePublication("event-a", registration, template, managed));
  let finish!: (value: SelectionNotice) => void, calls = 0;
  const publisher = async () => { calls++; return new Promise<SelectionNotice>(resolve => { finish = resolve; }); };
  const first = attempt.send(publisher, () => true);
  await assert.rejects(attempt.send(publisher, () => true), /仍在处理/);
  finish(receipt()); assert.equal((await first).version, 1); assert.equal(calls, 1);
  const again = await attempt.send(async () => { calls++; return receipt(2); }, () => true);
  assert.equal(again.version, 1); assert.equal(calls, 1); assert.equal(attempt.state, "published");
});
test("未知结果重试冻结完整请求，新模板/列表对象变化不产生新操作键", async () => {
  const existing = { ...managed, items: [receipt()] };
  const preview = prepareNoticePublication("event-a", registration, template, existing, "operation-stable");
  const attempt = new NoticePublicationAttempt(preview), calls: PublishSelectionNoticeInput[] = [];
  await assert.rejects(attempt.send(async input => { calls.push(structuredClone(input)); throw new Error("transport timeout"); }, () => true));
  assert.equal(attempt.state, "unknown");
  preview.input.newOperationKey = "changed-after-click"; preview.input.templateRevision = 99;
  await attempt.send(async input => { calls.push(structuredClone(input)); return receipt(2, { mailState: "unknown_hold" }); }, () => true);
  assert.deepEqual(calls[0], calls[1]); assert.equal(calls[1].newOperationKey, "operation-stable"); assert.equal(calls[1].templateRevision, 2);
  assert.equal(attempt.receipt?.mailState, "unknown_hold");
});
test("确定拒绝保留原参数，重试仍是原操作", async () => {
  const attempt = new NoticePublicationAttempt(prepareNoticePublication("event-a", registration, template, managed));
  await assert.rejects(attempt.send(async () => { throw new Error("revision conflict"); }, () => false));
  assert.equal(attempt.state, "rejected");
  assert.equal(attempt.preview.input.expectedNoticeVersion, 0); assert.equal(attempt.preview.input.templateRevision, 2);
  assert.equal((await attempt.send(async () => receipt(), () => true)).version, 1);
});
test("收据赛事、报名与版本不符时不得显示成功", async () => {
  for (const mismatch of [{ eventId: "other" }, { registrationId: "other" }, { version: 2 }, { templateRevision: 3 }, { registrationRevision: 5 }]) {
    const attempt = new NoticePublicationAttempt(prepareNoticePublication("event-a", registration, template, managed));
    await assert.rejects(attempt.send(async () => receipt(1, mismatch), () => true));
    assert.equal(attempt.state, "unknown"); assert.equal(attempt.receipt, null);
  }
});
test("模板变动不产生发布，已有版本必须走新版本输入", () => {
  const updated = { ...template, revision: 3, preview: { subject: "新标题", body: "新正文" } };
  assert.throws(() => prepareNoticePublication("event-a", registration, updated, { ...managed, items: [receipt()] }));
  const preview = prepareNoticePublication("event-a", registration, updated, { ...managed, items: [receipt()] }, "operation-new");
  assert.equal(preview.input.expectedNoticeVersion, 1); assert.equal(preview.input.confirmNewVersion, true); assert.equal(preview.input.templateRevision, 3);
  assert.equal(preview.currentVersion, 1);
});
