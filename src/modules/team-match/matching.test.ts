import assert from "node:assert/strict";
import test from "node:test";
import {
  groupCandidates,
  isOptInOpen,
  teamMatchGate,
} from "./index.ts";
import type {
  TeamMatchCandidateCard,
  TeamMatchGrouping,
  TeamMatchOptIn,
  TeamMatchPostFacts,
  TeamMatchPublishedCard,
  TeamMatchViewer,
} from "./index.ts";

const at = (minute = 0): string => `2026-10-18T00:${String(minute).padStart(2, "0")}:00.000Z`;

const published = (userId: string, overrides: Partial<TeamMatchPublishedCard> = {}): TeamMatchPublishedCard => ({
  id: `card-${userId}`,
  headline: "做过后端和前端",
  primaryRoles: ["backend"],
  supportingRoles: [],
  skills: ["TypeScript"],
  city: "杭州",
  publishedAt: at(0),
  updatedAt: at(0),
  ...overrides,
});

const candidate = (userId: string, overrides: Partial<TeamMatchCandidateCard> = {}): TeamMatchCandidateCard => ({
  userId,
  displayName: `选手${userId}`,
  registrationStatus: "approved",
  cardStatus: "published",
  card: published(userId),
  ...overrides,
});

const optIn = (userId: string, open = true, updatedAt = at(0)): TeamMatchOptIn => ({ userId, eventId: "event-1", open, updatedAt });

const post = (overrides: Partial<TeamMatchPostFacts> = {}): TeamMatchPostFacts => ({
  postId: "post-1",
  projectId: "project-1",
  spaceName: "示例空间",
  title: "找一位后端",
  status: "open",
  neededRoles: ["backend"],
  coveredRoles: [],
  seats: 4,
  takenSeats: 0,
  updatedAt: at(0),
  ...overrides,
});

const viewer = (overrides: Partial<TeamMatchViewer> = {}): TeamMatchViewer => ({
  userId: "viewer",
  eventId: "event-1",
  primaryRoles: ["frontend"],
  supportingRoles: [],
  city: "杭州",
  ...overrides,
});

const grouping = (input: Partial<Parameters<typeof groupCandidates>[0]> = {}): TeamMatchGrouping => groupCandidates({
  cards: [candidate("a")],
  posts: [post()],
  viewer: viewer(),
  optIns: [optIn("a")],
  ...input,
});

const candidateIds = (result: TeamMatchGrouping): string[] => result.groups.flatMap(group => group.candidates.map(item => item.userId));

const allKeys = (value: unknown, keys = new Set<string>()): Set<string> => {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, keys);
    return keys;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      allKeys(child, keys);
    }
  }
  return keys;
};

test("门槛①：报名未通过的人不出现，即使名片已发布且已开启愿意被组队", () => {
  const gate = teamMatchGate({
    card: candidate("pending", { registrationStatus: "pending" }),
    eventId: "event-1",
    optIns: [optIn("pending")],
    viewerUserId: "viewer",
  });
  assert.equal(gate.eligible, false);
  assert.deepEqual(gate.reasons, ["registration_not_approved"]);

  const result = grouping({ cards: [candidate("pending", { registrationStatus: "pending" })] });
  assert.deepEqual(result.groups, []);
  assert.deepEqual(result.unfilledRoles.map(item => item.role), ["backend"]);
  assert.match(result.notice, /没有同时满足/);
});

test("门槛②：名片撤回、未发布或投影不一致时不出现", () => {
  const withdrawn = teamMatchGate({
    card: candidate("withdrawn", { cardStatus: "withdrawn", card: null }),
    eventId: "event-1",
    optIns: [optIn("withdrawn")],
    viewerUserId: "viewer",
  });
  assert.deepEqual(withdrawn.reasons, ["card_not_published"]);

  const inconsistent = teamMatchGate({
    card: candidate("inconsistent", { cardStatus: "published", card: null }),
    eventId: "event-1",
    optIns: [optIn("inconsistent")],
    viewerUserId: "viewer",
  });
  assert.deepEqual(inconsistent.reasons, ["card_not_published"]);

  const result = grouping({ cards: [candidate("withdrawn", { cardStatus: "withdrawn", card: null })] });
  assert.deepEqual(result.groups, []);
});

test("门槛③：没有 opt-in 记录按未开启处理；显式关闭也按未开启", () => {
  const gate = teamMatchGate({ card: candidate("a"), eventId: "event-1", optIns: [], viewerUserId: "viewer" });
  assert.deepEqual(gate.reasons, ["opt_in_missing_or_closed"]);
  assert.equal(isOptInOpen([], "a", "event-1"), false);
  assert.equal(isOptInOpen([optIn("a", false)], "a", "event-1"), false);

  assert.deepEqual(grouping({ optIns: [] }).groups, []);
  assert.deepEqual(grouping({ optIns: [optIn("a", false)] }).groups, []);
});

test("三条门槛缺一不可：三人各缺一项全部落选，补齐后才出现", () => {
  const cards = [
    candidate("no-registration", { registrationStatus: "rejected" }),
    candidate("no-card", { cardStatus: "withdrawn", card: null }),
    candidate("no-opt-in"),
  ];
  const strict = grouping({
    cards,
    optIns: [optIn("no-registration"), optIn("no-card")],
  });
  assert.deepEqual(strict.groups, []);
  assert.deepEqual(strict.unfilledRoles.map(item => item.role), ["backend"]);

  const complete = grouping({
    cards: [...cards, candidate("complete")],
    optIns: [optIn("no-registration"), optIn("no-card"), optIn("complete")],
  });
  assert.deepEqual(candidateIds(complete), ["complete"], "只有三项都满足的人出现");
});

test("opt-in 以最后更新的一条为准，不把旧记录当成开启", () => {
  const closedLater = [optIn("a", true, at(1)), optIn("a", false, at(2))];
  assert.equal(isOptInOpen(closedLater, "a", "event-1"), false);
  assert.deepEqual(grouping({ optIns: closedLater }).groups, []);

  const openedLater = [optIn("a", false, at(1)), optIn("a", true, at(2))];
  assert.equal(isOptInOpen(openedLater, "a", "event-1"), true);
  assert.deepEqual(candidateIds(grouping({ optIns: openedLater })), ["a"]);
});

test("按职责缺口分组：已覆盖的职责和查看者自己已声明的职责都不再重复找人", () => {
  const result = grouping({
    viewer: viewer({ primaryRoles: ["frontend"] }),
    posts: [post({ neededRoles: ["frontend", "backend", "design"], coveredRoles: ["design"] })],
    cards: [
      candidate("backend-person"),
      candidate("design-person", { card: published("design-person", { primaryRoles: ["design"], supportingRoles: [] }) }),
    ],
    optIns: [optIn("backend-person"), optIn("design-person")],
  });

  assert.deepEqual(result.groups.map(group => group.role), ["backend"]);
  assert.equal(result.groups[0]!.roleLabel, "后端开发");
  assert.deepEqual(candidateIds(result), ["backend-person"]);
  assert.deepEqual(result.unfilledRoles, []);
});

test("同一候选只出现一次：重复投影合并，多职责按主角色优先归组并如实列出", () => {
  const card = published("a", { primaryRoles: ["backend"], supportingRoles: ["design"] });
  const result = grouping({
    viewer: viewer({ primaryRoles: ["product"] }),
    posts: [post({ neededRoles: ["backend", "design"] })],
    cards: [
      candidate("a", { card }),
      candidate("a", { card }),
      candidate("b", { card: published("b", { primaryRoles: ["design"] }) }),
    ],
    optIns: [optIn("a"), optIn("b")],
  });

  const ids = candidateIds(result);
  assert.equal(new Set(ids).size, ids.length, "整个结果里同一账号只出现一次");
  assert.deepEqual(result.groups.map(group => group.role), ["design", "backend"], "组按固定职责顺序排列");
  const backend = result.groups.find(group => group.role === "backend")!;
  assert.deepEqual(backend.candidates.map(item => item.userId), ["a"]);
  assert.deepEqual(backend.candidates[0]!.coveringRoles, ["design", "backend"], "能补但未归组的职责仍然列出");
  const design = result.groups.find(group => group.role === "design")!;
  assert.deepEqual(design.candidates.map(item => item.userId), ["b"]);
  assert.equal(ids.filter(id => id === "a").length, 1);
});

test("返回结构里没有 score/percent/rank 等分数字段，也没有百分比或最佳匹配措辞", () => {
  const result = grouping();
  const keys = [...allKeys(result)];
  for (const key of keys) {
    assert.doesNotMatch(key, /score|percent|rank|rating|weight|points|matchValue/i, `不应出现分数字段：${key}`);
  }
  const json = JSON.stringify(result);
  assert.doesNotMatch(json, /最佳匹配|最佳人选|匹配度|百分比|名次|分数|%/);
});

test("空名片输入返回空分组，并明确说明没有可展示的人", () => {
  const result = grouping({ cards: [] });
  assert.deepEqual(result.groups, []);
  assert.deepEqual(result.unfilledRoles.map(item => item.role), ["backend"]);
  assert.match(result.notice, /没有同时满足/);
  assert.deepEqual(result.evidence.length >= 3, true);
});

test("已发布但职责为空的名片不产生分组", () => {
  const result = grouping({
    cards: [candidate("empty", { card: published("empty", { primaryRoles: [], supportingRoles: [], skills: [], city: "" }) })],
    optIns: [optIn("empty")],
  });
  assert.deepEqual(result.groups, []);
  assert.deepEqual(result.unfilledRoles.map(item => item.role), ["backend"]);
});

test("招募贴没有声明职责时返回空分组", () => {
  const result = grouping({ posts: [post({ neededRoles: [] })] });
  assert.deepEqual(result.groups, []);
  assert.deepEqual(result.unfilledRoles, []);
  assert.match(result.notice, /没有需要别人补的职责缺口/);
});

test("没有开放中的招募贴时返回空分组", () => {
  const result = grouping({ posts: [] });
  assert.deepEqual(result.groups, []);
  assert.deepEqual(result.unfilledRoles, []);
  assert.match(result.notice, /还没有开放中/);
});

test("关闭、撤回或名额已满的招募贴不参与分组", () => {
  const posts = [
    post({ postId: "closed", status: "closed" }),
    post({ postId: "withdrawn", status: "withdrawn" }),
    post({ postId: "full", seats: 2, takenSeats: 2 }),
  ];
  const result = grouping({ posts });
  assert.deepEqual(result.groups, []);
  assert.deepEqual(result.unfilledRoles, []);
  assert.match(result.notice, /还没有开放中/);
});

test("同一职责跨多个招募贴合并为一组，neededBy 如实列出全部来源", () => {
  const result = grouping({
    posts: [
      post({ postId: "post-b", title: "找后端 B" }),
      post({ postId: "post-a", title: "找后端 A" }),
    ],
  });
  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.groups[0]!.neededBy.map(item => item.postId), ["post-a", "post-b"], "来源按 postId 稳定排列");
  assert.deepEqual(result.groups[0]!.candidates.map(item => item.userId), ["a"]);
});

test("组内稳定顺序：名片最近更新在前，时间相同按 userId；与输入顺序无关", () => {
  const cards = [
    candidate("b", { card: published("b", { updatedAt: at(5) }) }),
    candidate("a", { card: published("a", { updatedAt: at(6) }) }),
    candidate("c", { card: published("c", { updatedAt: at(6) }) }),
  ];
  const forward = grouping({ cards, optIns: [optIn("a"), optIn("b"), optIn("c")] });
  const backward = grouping({ cards: [...cards].reverse(), optIns: [optIn("a"), optIn("b"), optIn("c")] });

  assert.deepEqual(forward.groups[0]!.candidates.map(item => item.userId), ["a", "c", "b"]);
  assert.deepEqual(backward.groups[0]!.candidates.map(item => item.userId), ["a", "c", "b"]);
});

test("查看者自己不进入候选人，且同城事实只来自真实城市相等", () => {
  const result = grouping({
    cards: [
      candidate("viewer"),
      candidate("same-city", { card: published("same-city", { city: " 杭州 " }) }),
      candidate("other-city", { card: published("other-city", { city: "上海" }) }),
    ],
    optIns: [optIn("viewer"), optIn("same-city"), optIn("other-city")],
  });
  assert.deepEqual(candidateIds(result), ["other-city", "same-city"], "同一更新时间按 userId 排列");
  const byId = new Map(result.groups[0]!.candidates.map(item => [item.userId, item]));
  assert.equal(byId.get("same-city")!.sameCity, true);
  assert.equal(byId.get("other-city")!.sameCity, false);

  const unknownCity = grouping({
    cards: [candidate("a", { card: published("a", { city: "" }) })],
    viewer: viewer({ city: undefined }),
  });
  assert.equal(unknownCity.groups[0]!.candidates[0]!.sameCity, false);
});

test("候选人投影不包含简历、年龄、MBTI、头像或联系方式", () => {
  const result = grouping();
  const person = result.groups[0]!.candidates[0]!;
  assert.deepEqual(Object.keys(person).sort(), [
    "cardId", "city", "coveringRoles", "displayName", "headline", "primaryRoles",
    "publishedAt", "sameCity", "skills", "supportingRoles", "updatedAt", "userId",
  ]);
});
