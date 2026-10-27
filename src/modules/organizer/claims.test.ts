import assert from "node:assert/strict";
import test from "node:test";
import { organizerError, organizerFixture } from "./testing.ts";
import type { OrganizerClaimDiscoveryPort } from "./service.ts";

/** 内存候选 Port：只作测试夹具，证明服务不直接读自动发现存储。 */
function discoveryFixture(cards: { discoveryId: string; title: string; sourceUrl: string; sourceHost: string; analyzedAt: string | null }[], occupied: Set<string> = new Set()) {
  const calls: string[] = [];
  const port: OrganizerClaimDiscoveryPort = {
    async listCandidates(_sql, options) {
      calls.push(`list:${options.organizationId}`);
      return cards.map(card => ({ ...card, matchReason: card.title.includes(options.organizationName) ? "name_conflict" as const : "manual_pick" as const }));
    },
    async getClaimable(_sql, discoveryId) {
      calls.push(`get:${discoveryId}`);
      if (occupied.has(discoveryId)) return null;
      const card = cards.find(value => value.discoveryId === discoveryId);
      return card ? { discoveryId: card.discoveryId, sourceHost: card.sourceHost } : null;
    },
    async getCandidate(_sql, discoveryId) {
      calls.push(`candidate:${discoveryId}`);
      const card = cards.find(value => value.discoveryId === discoveryId);
      return card ? { ...card, matchReason: "manual_pick" as const } : null;
    },
  };
  return { port, calls, occupy: (id: string) => occupied.add(id) };
}

const CARDS = [
  { discoveryId: "discovery-a", title: "测试机构甲 AI 黑客松", sourceUrl: "https://hackertrip.space/hackathon/a", sourceHost: "hackertrip.space", analyzedAt: "2026-10-11T12:30:00.000Z" },
  { discoveryId: "discovery-b", title: "某高校创新赛", sourceUrl: "https://example.edu/x", sourceHost: "example.edu", analyzedAt: null },
];

test("候选匹配只作提示：不产生归属，且非本机构管理员读不到", async t => {
  const f = await organizerFixture(t, { discovery: discoveryFixture(CARDS).port });
  const { organization } = await f.approvedOrganization("ownerA"); await f.seedDiscoveries(CARDS.map(card => card.discoveryId));
  const candidates = await f.service.listClaimCandidates(f.users.ownerA, organization.id);
  assert.equal(candidates.length, 2);
  assert.equal(candidates.find(value => value.discoveryId === "discovery-a")!.matchReason, "name_conflict");
  assert.equal(candidates.find(value => value.discoveryId === "discovery-b")!.matchReason, "manual_pick");
  // 候选人可见不等于获得任何权限：未申请前没有任何认领记录。
  assert.deepEqual(await f.service.listClaims(f.users.ownerA, organization.id), []);
  await assert.rejects(f.service.listClaimCandidates(f.users.staff, organization.id), organizerError("ORGANIZER_FORBIDDEN"));
  await assert.rejects(f.service.listClaimCandidates(f.users.ownerB, organization.id), organizerError("ORGANIZER_FORBIDDEN"));
});

test("认领申请需归属依据，同一线索只能被认领一次", async t => {
  const discovery = discoveryFixture(CARDS);
  const f = await organizerFixture(t, { discovery: discovery.port });
  const { organization } = await f.approvedOrganization("ownerA"); await f.seedDiscoveries(CARDS.map(card => card.discoveryId));
  const other = await f.approvedOrganization("ownerB", "测试机构乙");

  await assert.rejects(f.service.createClaim(f.users.ownerA, organization.id, { discoveryId: "discovery-a", verification: "other", evidenceText: "" }), organizerError("ORGANIZER_INPUT_INVALID"));
  await assert.rejects(f.service.createClaim(f.users.ownerA, organization.id, { discoveryId: "discovery-a", verification: "猜的", evidenceText: "依据" }), organizerError("ORGANIZER_INPUT_INVALID"));
  await assert.rejects(f.service.createClaim(f.users.ownerA, organization.id, { discoveryId: "discovery-a", verification: "official_statement", evidenceText: "依据", evidenceUrls: ["http://insecure.example/x"] }), organizerError("ORGANIZER_INPUT_INVALID"));
  await assert.rejects(f.service.createClaim(f.users.ownerA, organization.id, { discoveryId: "不存在", verification: "official_statement", evidenceText: "依据" }), organizerError("ORGANIZER_NOT_FOUND"));

  const claim = await f.service.createClaim(f.users.ownerA, organization.id, { discoveryId: "discovery-a", verification: "official_statement", evidenceText: "官网公告署有本人联系方式", evidenceUrls: ["https://hackertrip.space/hackathon/a"] });
  assert.equal(claim.status, "pending");
  assert.equal(claim.sourceHost, "hackertrip.space");
  assert.equal(claim.hostedEventId, null);

  // 同机构重复申请、其他机构申请同一线索都被拒绝。
  await assert.rejects(f.service.createClaim(f.users.ownerA, organization.id, { discoveryId: "discovery-a", verification: "other", evidenceText: "再来一次" }), organizerError("ORGANIZER_CLAIM_TAKEN"));
  await assert.rejects(f.service.createClaim(f.users.ownerB, other.organization.id, { discoveryId: "discovery-a", verification: "other", evidenceText: "我是主办方" }), organizerError("ORGANIZER_CLAIM_TAKEN"));
});

test("只有平台管理员能批准，批准需要核实说明，且不能自审", async t => {
  const f = await organizerFixture(t, { discovery: discoveryFixture(CARDS).port });
  const { organization } = await f.approvedOrganization("ownerA"); await f.seedDiscoveries(CARDS.map(card => card.discoveryId));
  const claim = await f.service.createClaim(f.users.ownerA, organization.id, { discoveryId: "discovery-a", verification: "authorized_document", evidenceText: "盖章授权文件已通过线下核对" });

  await assert.rejects(f.service.reviewClaim(f.users.ownerA, claim.id, { decision: "approved", note: "自己批自己", expectedRevision: claim.revision }), organizerError("ORGANIZER_FORBIDDEN"));
  await assert.rejects(f.service.reviewClaim(f.users.reviewer, claim.id, { decision: "approved", note: "评审员不能批", expectedRevision: claim.revision }), organizerError("ORGANIZER_FORBIDDEN"));
  await assert.rejects(f.service.reviewClaim(f.users.administrator, claim.id, { decision: "approved", note: "", expectedRevision: claim.revision }), organizerError("ORGANIZER_INPUT_INVALID"));
  await assert.rejects(f.service.reviewClaim(f.users.administrator, claim.id, { decision: "approved", note: "批准", expectedRevision: claim.revision + 5 }), organizerError("ORGANIZER_REVISION_CONFLICT"));

  const approved = await f.service.reviewClaim(f.users.administrator, claim.id, { decision: "approved", note: "已核对官网公告与联系人署名", expectedRevision: claim.revision });
  assert.equal(approved.status, "approved");
  assert.equal(approved.reviewedBy, "administrator");
  assert.ok(approved.reviewNote);
  await assert.rejects(f.service.reviewClaim(f.users.administrator, claim.id, { decision: "rejected", note: "反悔", expectedRevision: approved.revision }), organizerError("ORGANIZER_CLAIM_STATE"));
});

test("撤回只影响待审核认领；被驳回或撤回后可重新申请", async t => {
  const f = await organizerFixture(t, { discovery: discoveryFixture(CARDS).port });
  const { organization } = await f.approvedOrganization("ownerA"); await f.seedDiscoveries(CARDS.map(card => card.discoveryId));
  const first = await f.service.createClaim(f.users.ownerA, organization.id, { discoveryId: "discovery-b", verification: "other", evidenceText: "第一次" });
  await assert.rejects(f.service.withdrawClaim(f.users.ownerA, first.id, { expectedRevision: first.revision + 1 }), organizerError("ORGANIZER_REVISION_CONFLICT"));
  const withdrawn = await f.service.withdrawClaim(f.users.ownerA, first.id, { expectedRevision: first.revision });
  assert.equal(withdrawn.status, "withdrawn");
  await assert.rejects(f.service.withdrawClaim(f.users.ownerA, first.id, { expectedRevision: withdrawn.revision }), organizerError("ORGANIZER_CLAIM_STATE"));

  // 撤回后同一线索可以再次申请；被驳回同理。
  const second = await f.service.createClaim(f.users.ownerA, organization.id, { discoveryId: "discovery-b", verification: "official_domain_mailbox", evidenceText: "改用官网邮箱核实" });
  assert.equal(second.status, "pending");
  await f.service.reviewClaim(f.users.administrator, second.id, { decision: "rejected", note: "邮箱域名与来源不一致", expectedRevision: second.revision });
  const third = await f.service.createClaim(f.users.ownerA, organization.id, { discoveryId: "discovery-b", verification: "platform_source_page", evidenceText: "平台官方页可核对" });
  assert.equal(third.status, "pending");
});

test("线索不可用时不得批准，也不能留下已批准事实", async t => {
  const discovery = discoveryFixture(CARDS);
  const f = await organizerFixture(t, { discovery: discovery.port });
  const { organization } = await f.approvedOrganization("ownerA"); await f.seedDiscoveries(CARDS.map(card => card.discoveryId));
  const claim = await f.service.createClaim(f.users.ownerA, organization.id, { discoveryId: "discovery-a", verification: "other", evidenceText: "依据" });
  discovery.occupy("discovery-a");
  await assert.rejects(f.service.reviewClaim(f.users.administrator, claim.id, { decision: "approved", note: "批准", expectedRevision: claim.revision }), organizerError("ORGANIZER_CLAIM_SOURCE_UNAVAILABLE"));
  const rejected = await f.service.reviewClaim(f.users.administrator, claim.id, { decision: "rejected", note: "来源已不可用", expectedRevision: claim.revision });
  assert.equal(rejected.status, "rejected");
});

test("会话失效、未登录与取消资格在写认领前被拒绝", async t => {
  const f = await organizerFixture(t, { discovery: discoveryFixture(CARDS).port });
  const { organization } = await f.approvedOrganization("ownerA"); await f.seedDiscoveries(CARDS.map(card => card.discoveryId));
  await assert.rejects(f.service.createClaim(f.principal("ownerA", { failAt: 2 }), organization.id, { discoveryId: "discovery-a", verification: "other", evidenceText: "依据" }), organizerError("AUTH_SESSION_INVALID"));
  await assert.rejects(f.service.createClaim(f.users.ownerB, organization.id, { discoveryId: "discovery-a", verification: "other", evidenceText: "依据" }), organizerError("ORGANIZER_FORBIDDEN"));
  assert.equal((await f.counts()).organizer_claim_requests, 0);
});

test("未接入自动发现时认领入口明确不可用，不伪造成功", async t => {
  const f = await organizerFixture(t);
  const { organization } = await f.approvedOrganization("ownerA"); await f.seedDiscoveries(CARDS.map(card => card.discoveryId));
  await assert.rejects(f.service.listClaimCandidates(f.users.ownerA, organization.id), organizerError("ORGANIZER_CLAIM_UNAVAILABLE"));
});
