import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../shared/errors.ts";
import { author, PROJECT_ID, setup } from "./testing/fixtures.ts";

test("optional publication guard runs twice before writing, but not on successful replay or shared reads", async () => {
  const f = setup(); let calls = 0;
  f.sourcePort.validateNewPublication = async (input, sql) => {
    calls++; assert.equal(input.actor.userId, author.userId); assert.equal(input.projectId, PROJECT_ID);
    assert.equal(input.source.sourceKind, "feasibility"); assert.ok(f.repository.executors.includes(sql));
    assert.equal(f.repository.snapshot().suggestions.length, 0, "both guard calls precede the insert");
  };
  const command = f.command({ sourceKind: "feasibility", sourceId: "feasibility-alice" });
  const receipt = await f.service.publish(author, PROJECT_ID, command); assert.equal(calls, 2);
  f.sourcePort.validateNewPublication = async () => { throw new Error("Old reports must not trigger new-publication guards on replay/read"); };
  assert.equal((await f.service.publish(author, PROJECT_ID, command)).replayed, true);
  assert.equal((await f.service.listFeed(author, PROJECT_ID)).items[0]?.id, receipt.id);
  assert.equal((await f.service.listSharedContext(author, PROJECT_ID))[0]?.id, receipt.id);
  assert.equal(f.repository.snapshot().suggestions.length, 1);
});

test("a changed source at the final publication guard rolls back suggestion, receipt and audit", async () => {
  const f = setup(); let calls = 0;
  f.sourcePort.validateNewPublication = async () => {
    if (++calls === 2) throw new DomainError("ASSISTANT_REPORT_STALE", "规则或共享依据已变更。", { status: 409 });
  };
  await assert.rejects(f.service.publish(author, PROJECT_ID, f.command({ sourceKind: "feasibility", sourceId: "feasibility-alice" })), (error: unknown) => error instanceof DomainError && error.code === "ASSISTANT_REPORT_STALE");
  assert.equal(calls, 2); assert.equal(f.repository.snapshot().suggestions.length, 0);
  assert.equal(f.repository.snapshot().audits.length, 0); assert.equal(f.repository.snapshot().receipts.length, 0);
});

test("publish, edit, adopt and withdraw all enter the root mutation scope before opening the feed transaction", async () => {
  const f = setup(); let inScope = false, scopes = 0;
  const transaction = f.repository.transaction.bind(f.repository);
  f.repository.transaction = async (projectId, work) => {
    assert.equal(inScope, true, "the root must take its planning/project locks before the feed lock");
    return transaction(projectId, work);
  };
  f.accessPort.withMutationScope = async (projectId, actor, work) => {
    assert.equal(projectId, PROJECT_ID); assert.equal(actor.userId, author.userId);
    assert.equal(inScope, false); inScope = true; scopes++;
    try { return await work(); } finally { inScope = false; }
  };
  // The author is a real manager in this test's injected membership port.
  f.membership(author).role = "manager";
  const created = await f.service.publish(author, PROJECT_ID, f.command());
  const edited = await f.service.edit(author, PROJECT_ID, created.id, { expectedRevision: created.revision, title: "更新摘录", body: "核对一个实际示例", idempotencyKey: "edit-scope" });
  const adopted = await f.service.adopt(author, PROJECT_ID, created.id, { expectedRevision: edited.revision, idempotencyKey: "adopt-scope" });
  await f.service.withdraw(author, PROJECT_ID, created.id, { expectedRevision: adopted.revision, idempotencyKey: "withdraw-scope" });
  assert.equal(scopes, 4); assert.equal(inScope, false);
});
