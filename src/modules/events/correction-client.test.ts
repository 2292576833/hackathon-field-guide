import test from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { CorrectionService, createCorrectionHandlers } from "../operations/index.ts";
import type { Correction, CorrectionRepository, CorrectionTransaction } from "../operations/index.ts";
import { createEventCorrectionClient, EventCorrectionApiError, eventCorrectionStatuses, getFormalEventCorrectionTarget, makeEventCorrectionInput, ownEventCorrections } from "./correction-client.ts";
import type { PublicEvent } from "./model.ts";

const owner: Actor = { userId: "owner", platformRoles: ["user"] };
const stranger: Actor = { userId: "stranger", platformRoles: ["user"] };
const reviewer: Actor = { userId: "reviewer", platformRoles: ["reviewer"] };
function formalEvent(): PublicEvent {
  return {
    event: { id: "event-1", revision: 4, publicationStatus: "published", candidateVersion: 2, publishedVersion: 1, lastVerifiedAt: null },
    rules: { eventId: "event-1", version: 1, createdAt: "2026-10-10T00:00:00Z", metadata: { name: "正式赛事", organizer: "主办方", format: "online", region: "全球", officialUrl: "https://example.org/rules" }, sources: [], evidence: [], facts: [], stages: [], requirements: [], qualityFlags: [] },
  };
}
function fixture() {
  let actor: Actor | null = owner, nextId = 0, mutationChecks = 0;
  const records = new Map<string, Correction>();
  const repository: CorrectionRepository = {
    async transaction<T>(work: (tx: CorrectionTransaction) => Promise<T>): Promise<T> {
      const draft = structuredClone(records);
      const tx: CorrectionTransaction = {
        query: async () => ({ rows: [], rowCount: 0 }),
        getCorrection: async id => draft.get(id) ?? null,
        insertCorrection: async record => { draft.set(record.id, record); },
        saveCorrection: async (record, expected) => { if (draft.get(record.id)?.revision !== expected) throw new DomainError("VERSION_CONFLICT", "版本发生变化"); draft.set(record.id, record); },
        appendTransition: async () => undefined,
      };
      const result = await work(tx); records.clear(); draft.forEach((record, id) => records.set(id, record)); return result;
    },
    listOwn: async userId => [...records.values()].filter(record => record.submittedBy === userId),
    listQueue: async status => [...records.values()].filter(record => !status || record.status === status),
  };
  const service = new CorrectionService({ repository, targets: { isPublicVersion: async (_tx, target) => target.kind === "event" && target.entityId === "event-1" && [1, 2].includes(target.version) }, clock: { now: () => new Date("2026-10-10T01:00:00Z") }, ids: { next: () => `correction-${++nextId}` } });
  const handlers = createCorrectionHandlers({ service, resolveActor: async () => actor, requestId: () => "req", assertMutationAllowed: async () => { mutationChecks++; } });
  const calls: { path: string; method: string; body: unknown }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(new URL(String(input), "https://station.example"), init);
    const path = new URL(request.url).pathname;
    calls.push({ path, method: request.method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (path === "/api/v1/corrections") return handlers.submit(request);
    if (path === "/api/v1/me/corrections") return handlers.listOwn(request);
    if (path.startsWith("/api/v1/me/corrections/")) return handlers.getOwn(decodeURIComponent(path.slice("/api/v1/me/corrections/".length)))(request);
    throw new Error("Unexpected route");
  };
  return { client: createEventCorrectionClient(fetcher), service, records, calls, setActor: (next: Actor | null) => { actor = next; }, mutationChecks: () => mutationChecks };
}
function input() { return makeEventCorrectionInput("event-1", formalEvent(), { field: "报名截止", reason: "official_update", message: "官网公告更新了报名日期，报名与作品提交日期不同。", evidenceText: "https://example.org/announcement" }); }

test("formal event input binds the published rules version and rejects discovery or candidate references", () => {
  assert.deepEqual(input().target, { kind: "event", entityId: "event-1", version: 1 });
  assert.match(input().message, /^原因：官方信息已更新\n/);
  const draft = formalEvent(); draft.event.publicationStatus = "draft"; draft.event.publishedVersion = null;
  assert.throws(() => getFormalEventCorrectionTarget("event-1", draft), /正式发布/);
  const candidate = formalEvent(); candidate.rules.version = 2;
  assert.throws(() => getFormalEventCorrectionTarget("event-1", candidate), /正式发布/);
  const pending = formalEvent(); pending.event.publicationStatus = "pending_review";
  assert.equal(getFormalEventCorrectionTarget("event-1", pending).version, 1, "published prior version remains accessible while a newer candidate is reviewed");
  assert.throws(() => getFormalEventCorrectionTarget("discovery-1", formalEvent()), /DSH/);
  assert.throws(() => getFormalEventCorrectionTarget("discovery-1", { id: "discovery-1" } as unknown as PublicEvent), /DSH/);
  assert.throws(() => makeEventCorrectionInput("event-1", formalEvent(), { field: "日期", reason: "incorrect", message: "请核对", evidenceText: "https://user:secret@example.org/" }), /账号密码/);
});

test("client reuses M08 station queue and own-status HTTP, with server-enforced account isolation", async () => {
  const f = fixture();
  const saved = await f.client.submit(input());
  assert.equal(saved.submittedBy, owner.userId); assert.equal(saved.status, "received");
  assert.equal(f.records.size, 1); assert.equal(f.mutationChecks(), 1);
  assert.deepEqual(f.calls[0], { path: "/api/v1/corrections", method: "POST", body: input() });
  assert.equal((await f.client.getOwn(saved.id)).id, saved.id);
  const own = await f.client.listOwn(); assert.equal(own.length, 1);
  assert.equal(f.mutationChecks(), 1, "GETs do not authorize writes, start models or mutate rules");
  f.setActor(stranger);
  assert.deepEqual(await f.client.listOwn(), []);
  await assert.rejects(f.client.getOwn(saved.id), error => error instanceof EventCorrectionApiError && error.status === 404);
  assert.deepEqual(ownEventCorrections(own, "event-1", stranger.userId), [], "old UI data is not retained across account changes");
  assert.deepEqual(ownEventCorrections(own, "event-1", null), []);
  f.setActor(null);
  await assert.rejects(f.client.listOwn(), error => error instanceof EventCorrectionApiError && error.status === 401);
  assert.equal(f.records.size, 1);
});

test("published version validation remains server-authoritative for a forged discovery ID", async () => {
  const f = fixture();
  await assert.rejects(f.client.submit({ ...input(), target: { kind: "event", entityId: "discovery-1", version: 1 } }), error => error instanceof EventCorrectionApiError && error.status === 404);
  assert.equal(f.records.size, 0);
});

test("own UI reads real triage, needs-info, confirmed and resolution results without inventing publication", async () => {
  const f = fixture(); const saved = await f.client.submit(input());
  await f.service.process(reviewer, saved.id, { expectedRevision: 1, status: "triaging", reason: "开始核对官网公告" }, "r1");
  assert.equal((await f.client.getOwn(saved.id)).status, "triaging");
  await f.service.process(reviewer, saved.id, { expectedRevision: 2, status: "needs_more_info", reason: "请补充公告对应段落" }, "r2");
  let state = await f.client.getOwn(saved.id);
  assert.equal(state.status, "needs_more_info"); assert.equal(state.response, "请补充公告对应段落");
  await f.service.process(reviewer, saved.id, { expectedRevision: 3, status: "triaging", reason: "已取得补充来源" }, "r3");
  await f.service.process(reviewer, saved.id, { expectedRevision: 4, status: "confirmed", reason: "报名日期确有更新" }, "r4");
  state = await f.client.getOwn(saved.id);
  assert.equal(eventCorrectionStatuses[state.status].label, "已确认，等待修正"); assert.equal(state.relatedVersion, null);
  await f.service.process(reviewer, saved.id, { expectedRevision: 5, status: "resolved", reason: "已审核并发布修正后的规则", relatedVersion: { kind: "event", entityId: "event-1", version: 2 } }, "r5");
  state = await f.client.getOwn(saved.id);
  assert.equal(state.status, "resolved"); assert.equal(state.relatedVersion?.version, 2);
  assert.deepEqual(state.original, saved.original, "the immutable original is retained");
  assert.equal(ownEventCorrections(await f.client.listOwn(), "event-1", owner.userId).length, 1);
  assert.match(eventCorrectionStatuses.resolved.description, /不代表规则必然更新/);
});
