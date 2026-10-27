import test from "node:test";
import assert from "node:assert/strict";
import { SourceService } from "./source-service.ts";
import { admin, draft, ExecutionTestRepository, executionFixture, MutableClock, ordinaryUser, reviewer, SequenceIds } from "./source-test-fixtures.ts";

test("source writes are admin-only; reviewer has public operations read access", async () => {
  const fixture = await executionFixture();
  await assert.rejects(fixture.sources.create(reviewer, draft), { code: "SOURCE_ADMIN_REQUIRED" });
  await assert.rejects(fixture.sources.create(ordinaryUser, draft), { code: "SOURCE_ADMIN_REQUIRED" });
  await assert.rejects(fixture.sources.list(ordinaryUser), { code: "OPERATIONS_FORBIDDEN" });
  assert.equal((await fixture.sources.get(reviewer, fixture.source.id)).id, fixture.source.id);
  assert.equal((await fixture.sources.list(reviewer)).length, 1);
});
test("unverified source cannot enable; verified actor/time are server-derived", async () => {
  const repository = new ExecutionTestRepository();
  const clock = new MutableClock();
  const service = new SourceService({ repository, clock, ids: new SequenceIds() });
  const source = await service.create(admin, draft);
  await assert.rejects(service.transition(admin, source.id, { expectedRevision: source.revision, status: "enabled", reason: "直接开启" }), { code: "INVALID_SOURCE_TRANSITION" });
  const verifying = await service.transition(admin, source.id, { expectedRevision: source.revision, status: "verifying", reason: "核查" });
  await assert.rejects(service.transition(admin, source.id, { expectedRevision: verifying.revision, status: "enabled", reason: "开启" }), { code: "SOURCE_VERIFICATION_REQUIRED" });
  assert.equal((await repository.getSource(source.id))?.status, "verifying");
});
test("CAS rejects simultaneous stale update; configuration edit revokes approval", async () => {
  const { sources, source, repository } = await executionFixture();
  const competing = await Promise.allSettled([sources.transition(admin, source.id, { expectedRevision: source.revision, status: "paused", reason: "暂停抓取" }), sources.transition(admin, source.id, { expectedRevision: source.revision, status: "degraded", reason: "页面变更" })]);
  assert.equal(competing.filter((result) => result.status === "fulfilled").length, 1);
  const failed = competing.find((result) => result.status === "rejected");
  assert.equal(failed?.status === "rejected" && failed.reason.code, "VERSION_CONFLICT");
  const current = (await repository.getSource(source.id))!;
  const revised = await sources.revise(admin, source.id, { expectedRevision: current.revision, reason: "修改频率", config: { ...draft, minimumIntervalSeconds: 600, networkPolicy: { ...draft.networkPolicy, version: 2 } } });
  assert.equal(revised.status, "verifying");
  assert.equal(revised.verification, null);
  assert.equal(repository.audits.at(-1)?.revision, revised.revision);
  await assert.rejects(sources.transition(admin, source.id, { expectedRevision: undefined as unknown as number, status: "enabled", reason: "无版本请求" }), { code: "VERSION_CONFLICT" });
});
test("audit failure rolls back source mutation", async () => {
  const { sources, source, repository } = await executionFixture();
  repository.failAudit = true;
  await assert.rejects(sources.transition(admin, source.id, { expectedRevision: source.revision, status: "paused", reason: "暂停" }), /audit unavailable/);
  assert.equal((await repository.getSource(source.id))?.revision, source.revision);
  assert.equal((await repository.getSource(source.id))?.status, "enabled");
});
