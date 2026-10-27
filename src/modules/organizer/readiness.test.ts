import assert from "node:assert/strict";
import test from "node:test";
import { organizerError, organizerFixture } from "./testing.ts";
import type { OrganizerClaimDiscoveryPort, OrganizerReadinessEvidencePort } from "./service.ts";

const CARD = { discoveryId: "discovery-r", title: "测试机构甲 待补字段赛", sourceUrl: "https://example.edu/r", sourceHost: "example.edu", analyzedAt: "2026-10-11T12:00:00.000Z" };
function discoveryPort(): OrganizerClaimDiscoveryPort {
  return {
    async listCandidates() { return [{ ...CARD, matchReason: "name_conflict" as const }]; },
    async getClaimable(_sql, discoveryId) { return discoveryId === CARD.discoveryId ? { discoveryId: CARD.discoveryId, sourceHost: CARD.sourceHost } : null; },
    async getCandidate(_sql, discoveryId) { return discoveryId === CARD.discoveryId ? { ...CARD, matchReason: "manual_pick" as const } : null; },
  };
}
/** 只读证据 Port 夹具：只给"赛道"和"费用"两条线索，其余为空。 */
function evidencePort(fields: Record<string, readonly string[]> = { tracks: ["原文：赛道分 AI Agent 与 游戏"], fee: ["原文：报名费 199 元"] }): OrganizerReadinessEvidencePort {
  return {
    async read() { return { sourceUrl: CARD.sourceUrl, checkedAt: "2026-10-11T12:00:00.000Z", fields }; },
  };
}

async function fixtureWithClaim(t: Parameters<typeof organizerFixture>[0], evidence = evidencePort()) {
  const f = await organizerFixture(t, { discovery: discoveryPort(), readinessEvidence: evidence });
  const { organization } = await f.approvedOrganization("ownerA");
  await f.seedDiscoveries([CARD.discoveryId]);
  const event = await f.createEvent(organization.id, f.users.ownerA, "待补字段赛");
  const claim = await f.service.createClaim(f.users.ownerA, organization.id, { discoveryId: CARD.discoveryId, verification: "official_statement", evidenceText: "官网公告署名" });
  const approved = await f.service.reviewClaim(f.users.administrator, claim.id, { decision: "approved", note: "已核对官网公告", expectedRevision: claim.revision });
  // 认领通过后需显式挂接到本机构的一场赛事，证据才与该赛事关联。
  await f.service.linkClaimToEvent(f.users.ownerA, approved.id, { eventId: event.eventId, expectedRevision: approved.revision });
  return { f, organization, event };
}

test("清单为派生视图：按优先级排序，报名截止排第一，且不产生任何写入", async t => {
  const { f, event } = await fixtureWithClaim(t);
  const before = (await f.counts()).organizer_event_profiles;
  const items = await f.service.listEventReadiness(f.users.ownerA, event.eventId);
  assert.equal(items[0]!.field, "registrationClosesAt");
  assert.equal(items[0]!.priority, 1);
  assert.equal(items.filter(item => item.priority === 1).length, 1);
  // 读取不写库、不产生完成度
  assert.equal((await f.counts()).organizer_event_profiles, before);
  assert.ok(items.every(item => !("completed" in item) && !("percent" in item)));
});

test("状态区分主办方确认、仅抓取线索与缺失；时间类来自比赛配置", async t => {
  const { f, event } = await fixtureWithClaim(t);
  const items = await f.service.listEventReadiness(f.users.ownerA, event.eventId);
  const byField = Object.fromEntries(items.map(item => [item.field, item]));
  // 比赛配置里已有报名开始/截止、开赛、结束、时区
  for (const field of ["registrationClosesAt","registrationOpensAt","startsAt","endsAt","timezone"]) {
    assert.equal(byField[field]!.state, "known_from_organizer", `${field} 应来自比赛配置`);
    assert.ok(byField[field]!.organizerValue);
  }
  // 只有抓取线索的项必须是 known_from_source，不能标成主办方确认
  assert.equal(byField.tracks!.state, "known_from_source");
  assert.equal(byField.fee!.state, "known_from_source");
  assert.match(byField.tracks!.sourceEvidence[0]!, /赛道/);
  assert.equal(byField.tracks!.sourceUrl, CARD.sourceUrl);
  assert.equal(byField.eligibility!.state, "missing");
  assert.equal(byField.eligibility!.organizerValue, null);
});

test("补全写入赛事补充资料并进入已确认状态；两侧不一致时为 conflicting", async t => {
  const { f, event } = await fixtureWithClaim(t);
  const saved = await f.service.updateEventReadiness(f.users.ownerA, event.eventId, { field: "eligibility", value: "面向在校学生，需学生证", expectedRevision: 0 });
  assert.equal(saved.revision, 1);
  assert.equal(saved.values.eligibility, "面向在校学生，需学生证");
  let items = await f.service.listEventReadiness(f.users.ownerA, event.eventId);
  assert.equal(items.find(item => item.field === "eligibility")!.state, "known_from_organizer");

  // 与抓取线索同时存在时必须报冲突，不自动取任一侧
  await f.service.updateEventReadiness(f.users.ownerA, event.eventId, { field: "fee", value: "免费", expectedRevision: saved.revision });
  items = await f.service.listEventReadiness(f.users.ownerA, event.eventId);
  const fee = items.find(item => item.field === "fee")!;
  assert.equal(fee.state, "conflicting");
  assert.equal(fee.organizerValue, "免费");
  assert.ok(fee.sourceEvidence.length > 0);
});

test("并发与版本校验：过期 revision 被拒且不覆盖", async t => {
  const { f, event } = await fixtureWithClaim(t);
  const first = await f.service.updateEventReadiness(f.users.ownerA, event.eventId, { field: "tracks", value: "AI Agent", expectedRevision: 0 });
  await assert.rejects(f.service.updateEventReadiness(f.users.ownerA, event.eventId, { field: "tracks", value: "游戏", expectedRevision: 0 }), organizerError("ORGANIZER_REVISION_CONFLICT"));
  const current = await f.service.getEventProfile(f.users.ownerA, event.eventId);
  assert.equal(current?.values.tracks, "AI Agent");
  assert.equal(current?.revision, first.revision);
});

test("清空用 null：删除该值并回到抓取线索或缺失，不用线索顶替", async t => {
  const { f, event } = await fixtureWithClaim(t);
  const saved = await f.service.updateEventReadiness(f.users.ownerA, event.eventId, { field: "aiPolicy", value: "允许使用 AI 辅助，需在 README 说明", expectedRevision: 0 });
  const cleared = await f.service.updateEventReadiness(f.users.ownerA, event.eventId, { field: "aiPolicy", value: null, expectedRevision: saved.revision });
  assert.equal(cleared.values.aiPolicy, undefined);
  const items = await f.service.listEventReadiness(f.users.ownerA, event.eventId);
  assert.notEqual(items.find(item => item.field === "aiPolicy")!.state, "known_from_organizer");
});

test("时间类与输入校验：时间字段回比赛配置，非法值被拒", async t => {
  const { f, event } = await fixtureWithClaim(t);
  await assert.rejects(f.service.updateEventReadiness(f.users.ownerA, event.eventId, { field: "registrationClosesAt", value: "2026-11-01T10:00:00Z", expectedRevision: 0 }), organizerError("ORGANIZER_READINESS_CONFIGURED_FIELD"));
  await assert.rejects(f.service.updateEventReadiness(f.users.ownerA, event.eventId, { field: "不存在的项", value: "x", expectedRevision: 0 }), organizerError("ORGANIZER_INPUT_INVALID"));
  await assert.rejects(f.service.updateEventReadiness(f.users.ownerA, event.eventId, { field: "tracks", value: "x".repeat(2001), expectedRevision: 0 }), organizerError("ORGANIZER_INPUT_INVALID"));
  await assert.rejects(f.service.updateEventReadiness(f.users.ownerA, event.eventId, { field: "tracks", value: "赛道", expectedRevision: 0, extra: 1 }), organizerError("ORGANIZER_INPUT_INVALID"));
});

test("权限：非本赛事工作人员读写被拒；会话失效在写前拒绝", async t => {
  const { f, organization, event } = await fixtureWithClaim(t);
  await assert.rejects(f.service.listEventReadiness(f.users.ownerB, event.eventId), organizerError("ORGANIZER_FORBIDDEN"));
  await assert.rejects(f.service.listEventReadiness(f.users.staff, event.eventId), organizerError("ORGANIZER_FORBIDDEN"));
  await assert.rejects(f.service.updateEventReadiness(f.users.ownerB, event.eventId, { field: "tracks", value: "x", expectedRevision: 0 }), organizerError("ORGANIZER_FORBIDDEN"));
  await assert.rejects(f.service.updateEventReadiness(f.principal("ownerA", { failAt: 2 }), event.eventId, { field: "tracks", value: "x", expectedRevision: 0 }), organizerError("AUTH_SESSION_INVALID"));
  assert.equal((await f.counts()).organizer_event_profiles, 0);
  void organization;
});

test("未接入证据 Port 时清单仍可用，只是没有抓取线索（不伪造来源）", async t => {
  const f = await organizerFixture(t, { discovery: discoveryPort() });
  const { organization } = await f.approvedOrganization("ownerA");
  const event = await f.createEvent(organization.id, f.users.ownerA, "无证据赛");
  const items = await f.service.listEventReadiness(f.users.ownerA, event.eventId);
  assert.equal(items.length, 12);
  assert.ok(items.every(item => item.sourceEvidence.length === 0 && item.sourceUrl === null));
  assert.equal(items.find(item => item.field === "tracks")!.state, "missing");
});
