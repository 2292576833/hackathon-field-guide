import assert from "node:assert/strict";
import test from "node:test";
import type { EventCommunityConfig } from "../../shared/organizer-contracts.ts";
import { DEFAULT_EVENT_COMMUNITY } from "../../shared/organizer-contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { WorkComment } from "./model.ts";
import {
  absoluteCommentMaxLength, commentCooldownRemaining, commentCooldownSeconds, commentGate, commentHideReason,
  commentIdempotencyKey, commentLimit, commentPage, commentPageLimit, commentReportReason, commentText, commentView,
  commentViewerAccess, visibleComments, workCommentNotices, workCommentsLimitations, workCommentsNotice,
} from "./comments.ts";

/**
 * 规划 34 C② 文字留言的**纯逻辑**验收：三层门禁、可见性、长度取自配置、限频、隐藏/举报投影、文案口径。
 * 这些都是行为断言（不是目测），且不依赖任何数据库或事务。
 */
const currentTime = "2026-10-16T08:00:00.000Z";
const at = (seconds: number): string => new Date(Date.parse(currentTime) + seconds * 1000).toISOString();
const community = (overrides: Partial<EventCommunityConfig> = {}): EventCommunityConfig => ({ ...DEFAULT_EVENT_COMMUNITY, ...overrides });
const disclosure = (scope: "private" | "participants" | "public", status: "active" | "withdrawn" = "active") => ({ scope, status });
const comment = (overrides: Partial<WorkComment> = {}): WorkComment => ({
  id: "comment-1", organizationId: "org-a", eventId: "event-a", teamId: "team-a", snapshotId: "snap-1",
  authorUserId: "alice", text: "这是一条留言", status: "active", revision: 1, createdAt: currentTime,
  hiddenAt: null, hiddenByUserId: null, hiddenByRole: null, hiddenReason: "", idempotencyKey: "key-1", ...overrides });
const code = (expected: string) => (error: unknown): boolean => error instanceof DomainError && error.code === expected && error.status === 422;

test("三层门禁：赛事作品展示、赛事文字留言、队伍本人公开缺一即 403，顺序固定且不返回空数组", () => {
  // ① 作品展示关闭：即使其余两层都满足也拒绝。
  const off = commentGate(community({ workShowcase: false, peerFeedback: true }), disclosure("public"))!;
  assert.equal(off.code, "WORK_SHOWCASE_DISABLED"); assert.equal(off.status, 403);
  // ② 展示已开、文字留言关闭：明确 WORK_COMMENTS_DISABLED（不是"没有留言"）。
  assert.equal(commentGate(community({ workShowcase: true, peerFeedback: false }), disclosure("participants"))!.code, "WORK_COMMENTS_DISABLED");
  // ③ 两层开关都开，但队伍本人没有选择公开 / 选择不公开 / 记录已撤回：一律 WORK_COMMENTS_NOT_DISCLOSED。
  assert.equal(commentGate(community({ workShowcase: true, peerFeedback: true }), null)!.code, "WORK_COMMENTS_NOT_DISCLOSED");
  assert.equal(commentGate(community({ workShowcase: true, peerFeedback: true }), disclosure("private"))!.code, "WORK_COMMENTS_NOT_DISCLOSED");
  assert.equal(commentGate(community({ workShowcase: true, peerFeedback: true }), disclosure("public", "withdrawn"))!.code, "WORK_COMMENTS_NOT_DISCLOSED");
  // 三层齐全才放行。
  assert.equal(commentGate(community({ workShowcase: true, peerFeedback: true }), disclosure("participants")), null);
  assert.equal(commentGate(community({ workShowcase: true, peerFeedback: true }), disclosure("public")), null);
});

test("观看者资格：participants 档只有本场报名已通过者，public 档任何已登录账号", () => {
  assert.equal(commentViewerAccess("participants", false)!.code, "WORK_COMMENTS_PARTICIPANTS_ONLY");
  assert.equal(commentViewerAccess("participants", false)!.status, 403);
  assert.equal(commentViewerAccess("participants", true), null);
  assert.equal(commentViewerAccess("public", false), null, "公开档对非参赛者的已登录账号同样开放");
  assert.equal(commentViewerAccess("public", true), null);
});

test("长度上限取自主办方配置，异常配置回退共享默认值且绝不放宽到无界", () => {
  assert.equal(commentLimit(community({ commentMaxLength: 50 })), 50);
  assert.equal(commentLimit(community({ commentMaxLength: 2000 })), 2000);
  assert.equal(commentLimit(community({ commentMaxLength: absoluteCommentMaxLength })), absoluteCommentMaxLength);
  for (const invalid of [0, -1, 1.5, absoluteCommentMaxLength + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(commentLimit(community({ commentMaxLength: invalid })), DEFAULT_EVENT_COMMUNITY.commentMaxLength, "配置异常必须回退默认值：" + String(invalid));
  }
});

test("正文校验：空、纯空白、控制字符、超长都拒绝；合法输入去掉首尾空白", () => {
  assert.throws(() => commentText("", 50), code("JUDGING_INVALID_INPUT"));
  assert.throws(() => commentText("   ", 50), code("JUDGING_INVALID_INPUT"));
  assert.throws(() => commentText(42, 50), code("JUDGING_INVALID_INPUT"));
  assert.throws(() => commentText("响铃\u0007字符", 50), code("JUDGING_INVALID_INPUT"));
  assert.throws(() => commentText("a".repeat(51), 50), code("JUDGING_INVALID_INPUT"));
  assert.equal(commentText("a".repeat(50), 50), "a".repeat(50), "恰好等于上限必须通过");
  assert.equal(commentText("  写清楚就好  ", 50), "写清楚就好");
  assert.equal(commentIdempotencyKey(" k-1 "), "k-1");
  assert.equal(commentHideReason(undefined), "");
  assert.equal(commentReportReason(undefined), "");
  assert.equal(commentHideReason("与队伍无关的人身评价"), "与队伍无关的人身评价");
  assert.throws(() => commentHideReason("x".repeat(301)), code("JUDGING_INVALID_INPUT"));
});

test("同账号同赛事限频：只看本账号在本赛事的全部留言（含已隐藏），其他人不受影响", () => {
  assert.equal(commentCooldownRemaining([], "alice", currentTime), 0);
  assert.equal(commentCooldownRemaining([comment()], "bob", currentTime), 0, "其他账号的留言不构成冷却");
  assert.equal(commentCooldownRemaining([comment({ createdAt: currentTime })], "alice", currentTime), commentCooldownSeconds);
  assert.equal(commentCooldownRemaining([comment({ createdAt: at(10) })], "alice", at(30)), commentCooldownSeconds - 20);
  assert.equal(commentCooldownRemaining([comment({ createdAt: currentTime })], "alice", at(commentCooldownSeconds)), 0, "冷却到点即可再留言");
  assert.equal(commentCooldownRemaining([comment({ createdAt: currentTime })], "alice", at(999)), 0);
  assert.equal(commentCooldownRemaining([comment({ status: "hidden" })], "alice", currentTime), commentCooldownSeconds, "隐藏不能绕过冷却");
  assert.equal(commentCooldownRemaining([comment({ createdAt: at(5) }), comment({ id: "comment-2", createdAt: at(20) })], "alice", at(25)), commentCooldownSeconds - 5, "取最新一条计算");
});

test("留言视图：不含作者账号；隐藏后正文为 null；作者与工作人员才看到可隐藏", () => {
  const mine = commentView(comment(), { viewerUserId: "alice", viewerIsStaff: false, reportedCount: 0, reportedByViewer: false });
  assert.equal(mine.isMine, true); assert.equal(mine.canHide, true); assert.equal(mine.canReport, true); assert.equal(mine.text, "这是一条留言");
  assert.ok(!JSON.stringify(mine).includes("alice"), "视图不返回作者账号（避免报复渠道）");
  const other = commentView(comment(), { viewerUserId: "bob", viewerIsStaff: false, reportedCount: 2, reportedByViewer: true });
  assert.equal(other.isMine, false); assert.equal(other.canHide, false); assert.equal(other.reportedCount, 2); assert.equal(other.reportedByViewer, true);
  const staff = commentView(comment(), { viewerUserId: "staff", viewerIsStaff: true, reportedCount: 0, reportedByViewer: false });
  assert.equal(staff.canHide, true, "本场工作人员可隐藏");
  const hidden = commentView(comment({ status: "hidden", revision: 2, hiddenAt: at(1), hiddenByUserId: "alice", hiddenByRole: "author" }), { viewerUserId: "bob", viewerIsStaff: true, reportedCount: 0, reportedByViewer: false });
  assert.equal(hidden.text, null, "隐藏后对任何人都不再返回正文");
  assert.equal(hidden.canHide, false); assert.equal(hidden.canReport, false); assert.equal(hidden.hiddenBy, "author");
  assert.ok(!JSON.stringify(hidden).includes("这是一条留言"));
  const keys = Object.keys(mine).sort();
  assert.deepEqual(keys, ["canHide", "canReport", "createdAt", "hiddenAt", "hiddenBy", "id", "isMine", "reportedByViewer", "reportedCount", "status", "teamId", "text"], "视图字段固定：没有任何评分/量纲/完成度字段");
});

test("列表投影：隐藏的不返回、按时间升序、超上限保留最新，并报出全量计数", () => {
  const records = [comment({ id: "c-3", createdAt: at(30) }), comment({ id: "c-1", createdAt: at(10) }), comment({ id: "c-2", status: "hidden", createdAt: at(20) })];
  assert.deepEqual(visibleComments(records).map(item => item.id), ["c-1", "c-3"]);
  const page = commentPage(records);
  assert.deepEqual(page.items.map(item => item.id), ["c-1", "c-3"]);
  assert.equal(page.totalCount, 2); assert.equal(page.hiddenCount, 1); assert.equal(page.truncated, false);
  const many = Array.from({ length: commentPageLimit + 5 }, (_, index) => comment({ id: "c-" + String(index).padStart(3, "0"), createdAt: at(index) }));
  const capped = commentPage(many);
  assert.equal(capped.items.length, commentPageLimit); assert.equal(capped.totalCount, commentPageLimit + 5); assert.equal(capped.truncated, true);
  assert.equal(capped.items[capped.items.length - 1]!.id, "c-" + String(commentPageLimit + 4).padStart(3, "0"), "保留最新");
  const tied = [comment({ id: "c-b", createdAt: currentTime }), comment({ id: "c-a", createdAt: currentTime })];
  assert.deepEqual(visibleComments(tied).map(item => item.id), ["c-a", "c-b"], "同时间按 id 稳定排序");
});

test("治理文案：写明本次是文字留言、不计入名次，且不含完成度/百分比或人身评价措辞", () => {
  const text = JSON.stringify({ workCommentNotices, workCommentsLimitations, workCommentsNotice });
  assert.match(workCommentsNotice, /文字留言/);
  assert.match(workCommentNotices.notRanked, /不计入名次/);
  assert.match(workCommentNotices.separate, /没有评分/);
  for (const forbidden of ["完成度", "百分比", "%", "进度条", "排名第", "榜"]) assert.ok(!text.includes(forbidden), "不得出现：" + forbidden);
  assert.match(workCommentNotices.hide, /只能隐藏一次/);
  assert.match(workCommentNotices.report, /只记录事实/);
  assert.match(workCommentNotices.rate, new RegExp(String(commentCooldownSeconds)));
  assert.ok(workCommentsLimitations.some(line => /不读不写任何互评数据/.test(line)));
});
