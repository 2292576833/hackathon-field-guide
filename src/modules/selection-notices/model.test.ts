import test from "node:test";
import assert from "node:assert/strict";
import { currentRegistrationNoticeText, latestSelectionNotice, mailStateText, prepareSelectionNoticeInput, renderNoticeExample, validateNoticeContent, type NoticeContent, type SelectionNotice } from "./model.ts";

const content: NoticeContent = { subject: "你已入选 {event}", body: "{name}，你好！\n请查看比赛安排。\n{organizer}", accent: "orange", theme: "letter" };
const registration = { id: "registration-a", userId: "user-a", revision: 4, status: "approved" };
function notice(version: number, patch: Partial<SelectionNotice> = {}): SelectionNotice {
  return { ...content, id: `notice-${version}`, eventId: "event-a", registrationId: registration.id, registrationRevision: 4, version, templateRevision: 2, publishedAt: "2026-10-11T06:00:00Z", mailState: "queued", ...patch };
}
test("通知文字仅支持三种变量、受控长度与单行标题", () => {
  assert.deepEqual(validateNoticeContent(content), []);
  for (const body of ["{email}", "{ name }", "{{name}}", "单独 {", "单独 }", "正文\u0000"])
    assert.ok(validateNoticeContent({ ...content, body }).length > 0, body);
  assert.ok(validateNoticeContent({ ...content, subject: "标题\r\nBcc: x" }).length);
  assert.ok(validateNoticeContent({ ...content, subject: "x".repeat(201) }).length);
  assert.ok(validateNoticeContent({ ...content, body: "x".repeat(12001) }).length);
  assert.ok(validateNoticeContent({ ...content, body: "   " }).length);
});
test("有限样式与强调色必须来自白名单", () => {
  assert.ok(validateNoticeContent({ ...content, accent: "red" as NoticeContent["accent"] }).length);
  assert.ok(validateNoticeContent({ ...content, theme: "<style>" as NoticeContent["theme"] }).length);
});
test("示例渲染保留字面HTML和变量值，替换值不递归当变量", () => {
  const preview = renderNoticeExample({ ...content, body: "<script>alert(1)</script>\n{name}" }, { name: "A {event}", event: "比赛 B", organizer: "组委会" });
  assert.equal(preview.subject, "你已入选 比赛 B");
  assert.equal(preview.body, "<script>alert(1)</script>\nA {event}");
});
test("首发只带0版本；新版需要明确确认和独立操作键", () => {
  assert.deepEqual(prepareSelectionNoticeInput(registration, 2, 0), { recipientUserId: "user-a", expectedRegistrationRevision: 4, templateRevision: 2, expectedNoticeVersion: 0 });
  assert.throws(() => prepareSelectionNoticeInput(registration, 2, 1));
  assert.throws(() => prepareSelectionNoticeInput(registration, 2, 1, "initial"));
  const next = prepareSelectionNoticeInput(registration, 2, 1, "operation-b");
  assert.equal(next.confirmNewVersion, true); assert.equal(next.newOperationKey, "operation-b"); assert.equal(next.expectedNoticeVersion, 1);
  assert.throws(() => prepareSelectionNoticeInput({ ...registration, status: "pending" }, 2, 0));
  assert.throws(() => prepareSelectionNoticeInput(registration, 0, 0));
});
test("最新通知由当前赛事和当前报名ID/版本筛选，保留历史但不借历史发新版", () => {
  assert.equal(latestSelectionNotice([notice(2), notice(1), notice(8, { eventId: "event-other" }), notice(6, { registrationRevision: 3 })], registration, "event-a")?.version, 2);
  assert.equal(latestSelectionNotice([notice(3, { registrationId: "other" })], registration, "event-a"), null);
});
test("每种邮件状态都有说明，服务接受绝不显示送达", () => {
  assert.match(mailStateText("accepted"), /收件与已读未确认/);
  assert.doesNotMatch(mailStateText("accepted"), /已送达|已到达/);
  assert.match(mailStateText("unknown_hold"), /未知.*暂停自动重发/);
  assert.match(mailStateText("unconfigured"), /未配置/);
  for (const state of ["queued", "leased", "sending", "failed", "cancelled"] as const) assert.ok(mailStateText(state).startsWith("邮件"));
});
test("撤回/拒绝后的历史通知不会表述为当前仍有资格", () => {
  for (const status of ["withdrawn", "rejected", "pending", "draft", null]) {
    assert.match(currentRegistrationNoticeText(status), /不表示当前仍具备参赛资格/);
    assert.doesNotMatch(currentRegistrationNoticeText(status), /当前报名已通过/);
  }
  assert.match(currentRegistrationNoticeText("approved"), /当前报名已通过审核/);
});
