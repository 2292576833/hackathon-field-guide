import assert from "node:assert/strict";
import test from "node:test";
import type { PublicRecruitingCard, RecruitingApplication, RecruitingPost } from "./model.ts";
import { gapView, type GapCard } from "./gap.ts";

const post = (overrides: Partial<RecruitingPost> = {}): RecruitingPost => ({ id: "post-1", projectId: "project-1", revision: 1, spaceName: "示例空间", title: "找两位队友",
  description: "做一个可运行的作品", neededRoles: ["frontend", "backend", "design"], purposes: ["build"], seats: 4, status: "open", publishedAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", ...overrides });
const card = (userId: string, roles: Partial<Pick<PublicRecruitingCard, "primaryRoles" | "supportingRoles">> = {}, overrides: Partial<PublicRecruitingCard> = {}): GapCard => ({ userId, card: {
  id: `card-${userId}`, displayName: `选手${userId}`, revision: 1, publishedAt: "2026-10-05T00:00:00.000Z", mbti: null, age: null, avatarUrl: null,
  headline: "做过后端和前端", introduction: "简介", purposes: ["build"], purposeNote: "", skills: [], city: "杭州", availableHoursPerDay: 3, workLinks: [],
  primaryRoles: [], supportingRoles: [], ...roles, ...overrides,
} });
const snapshot = (userId: string, roles: Partial<Pick<PublicRecruitingCard, "primaryRoles" | "supportingRoles">> = {}): PublicRecruitingCard => card(userId, roles).card;
const application = (applicantUserId: string, status: RecruitingApplication["status"], cardSnapshot: PublicRecruitingCard | null = null, displayName = `选手${applicantUserId}`): RecruitingApplication =>
  ({ id: `app-${applicantUserId}`, postId: "post-1", projectId: "project-1", applicantUserId, applicantDisplayName: displayName, message: "", cardSnapshot,
    status, revision: 1, reviewNote: "", reviewedBy: null, reviewedAt: null, membershipId: null, createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" });
const view = (input: Partial<Parameters<typeof gapView>[0]> = {}) => gapView({ post: post(), publisherUserId: "owner", applications: [], cards: [], takenSeats: 0, ...input });

test("没有通过本贴加入的人时，声明的职责全是缺口", () => {
  const result = view({ applications: [application("pending-1", "pending", snapshot("pending-1", { primaryRoles: ["frontend"] }))], cards: [card("pending-1", { primaryRoles: ["frontend"] })] });
  assert.deepEqual(result.gaps.map(item => item.role), ["frontend", "backend", "design"]);
  assert.deepEqual(result.coveredRoles, []);
  assert.match(result.notice, /还有 3 项职责没有通过本贴加入的人覆盖/);
  assert.equal(result.gaps[0]!.label, "前端开发");
});

test("通过本贴加入的人按名片声明覆盖职责，缺口随之减少", () => {
  const joined = application("joined-1", "joined", snapshot("joined-1", { primaryRoles: ["frontend"], supportingRoles: ["design"] }));
  const approved = application("approved-1", "approved", snapshot("approved-1", { primaryRoles: ["backend"] }));
  const result = view({ applications: [joined, approved], cards: [] });
  assert.deepEqual(result.coveredRoles.map(item => item.role), ["frontend", "backend", "design"]);
  assert.deepEqual(result.gaps, []);
  assert.match(result.notice, /都已经有通过本贴加入的人覆盖/);
  assert.deepEqual(result.coveredRoles[0]!.by, [{ userId: "joined-1", displayName: "选手joined-1" }]);
});

test("候选人只来自已发布名片，且排除在队列里/已加入/已拒绝/帖主本人", () => {
  const result = view({
    applications: [application("pending-1", "pending"), application("joined-1", "joined"), application("rejected-1", "rejected"), application("withdrawn-1", "withdrawn")],
    cards: [card("pending-1", { primaryRoles: ["backend"] }), card("joined-1", { primaryRoles: ["backend"] }), card("rejected-1", { primaryRoles: ["backend"] }),
      card("withdrawn-1", { primaryRoles: ["backend"] }), card("owner", { primaryRoles: ["backend"] }), card("fresh-1", { primaryRoles: ["backend"] })],
  });
  const backend = result.gaps.find(item => item.role === "backend")!;
  assert.deepEqual(backend.candidates.map(item => item.userId), ["fresh-1", "withdrawn-1"], "撤回申请的人可以再次出现；在队列、已加入、被拒与帖主本人都不再重复推送");
  assert.deepEqual(backend.candidates[0]!.coveringRoles, ["backend"]);
});

test("候选人按能补的缺口数量组织在同一职责下，并给出可核对依据说明", () => {
  const result = view({ cards: [card("a", { primaryRoles: ["backend"], supportingRoles: ["design"] }), card("b", { primaryRoles: ["backend"] })] });
  const backend = result.gaps.find(item => item.role === "backend")!;
  assert.deepEqual(backend.candidates[0]!.coveringRoles, ["backend", "design"], "名片同时补两项缺口时如实列出");
  assert.deepEqual(result.evidence, [
    "覆盖口径：只统计通过本招募帖批准或已加入的人；其他成员不在这个口径内。",
    "候选依据：对方已发布名片里的职责声明，属于本人自述，未经平台核验。",
    "这里不评分、不给匹配度，也不排能力先后；同一缺口下按名片更新时间排列，是否联系由你决定。",
  ]);
});

test("名片没有声明缺口职责的人不会出现在任何缺口下", () => {
  const result = view({ cards: [card("a", { primaryRoles: ["presentation"] })] });
  assert.ok(result.gaps.every(item => item.candidates.length === 0));
  assert.match(result.notice, /还有 3 项职责/);
});

test("名额已满时明确说明先处理名额，而不是鼓励继续拉人", () => {
  const result = view({ takenSeats: 4 });
  assert.equal(result.openSeats, 0);
  assert.match(result.notice, /名额已满（4\/4）/);
});

test("空缺职责时给出中性顺序与上限，且同一时间按账号标识稳定排序", () => {
  const cards = Array.from({ length: 15 }, (_, index) => card(`user-${String(index).padStart(2, "0")}`, { primaryRoles: ["backend"] }, { publishedAt: `2026-10-05T00:00:${String(index).padStart(2, "0")}.000Z` }));
  const result = view({ cards });
  const backend = result.gaps.find(item => item.role === "backend")!;
  assert.equal(backend.candidates.length, 12, "最多列出 12 位，避免变成一张排行榜");
  assert.equal(backend.candidates[0]!.publishedAt, "2026-10-05T00:00:14.000Z", "新的名片在前");
  const tied = view({ cards: [card("zeta", { primaryRoles: ["backend"] }), card("alpha", { primaryRoles: ["backend"] })] });
  assert.deepEqual(tied.gaps.find(item => item.role === "backend")!.candidates.map(item => item.userId), ["alpha", "zeta"], "同一时间按账号标识稳定排序");
});
