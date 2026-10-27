import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../shared/errors.ts";
import type { SuggestionReceipt, TeamFeedSnapshot, TeamSuggestion } from "./types.ts";
import { author, manager, teammate, NOW, OTHER_PROJECT_ID, PROJECT_ID, setup, taskActivity } from "./testing/fixtures.ts";

function code(expected: string, revision?: number) {
  return (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, expected);
    if (revision !== undefined) assert.equal(error.latestRevision, revision);
    return true;
  };
}
function suggestion(feed: TeamFeedSnapshot, id: string) {
  const value = feed.items.find(item => item.id === id);
  assert.ok(value?.kind === "suggestion");
  return value.suggestion;
}
function saved(fixture: ReturnType<typeof setup>, id: string): TeamSuggestion {
  const value = fixture.repository.snapshot().suggestions.find(item => item.id === id);
  assert.ok(value);
  return value;
}
async function publish(fixture: ReturnType<typeof setup>): Promise<SuggestionReceipt> {
  return fixture.service.publish(author, PROJECT_ID, fixture.command());
}

test("explicit sharing stores edited content and server source metadata, never the private answer", async () => {
  const f = setup();
  const receipt = await publish(f);
  assert.deepEqual(receipt, { id: receipt.id, revision: 1, status: "discussion", replayed: false });
  const own = suggestion(await f.service.listFeed(author, PROJECT_ID), receipt.id);
  assert.equal(own.source.label, "服务端来源：navigator");
  assert.equal(own.source.sourceId, "navigator-alice");
  assert.equal(own.body, "本人选择并编辑后共享的建议片段。");
  assert.equal(own.canEdit, true); assert.equal(own.canWithdraw, true); assert.equal(own.canAdopt, false);
  const other = suggestion(await f.service.listFeed(teammate, PROJECT_ID), receipt.id);
  assert.equal(other.canEdit, false); assert.equal(other.canWithdraw, false);
  assert.equal(suggestion(await f.service.listFeed(manager, PROJECT_ID), receipt.id).canAdopt, true);
  const context = await f.service.listSharedContext(teammate, PROJECT_ID);
  assert.equal(context[0]!.authorUserId, author.userId);
  assert.ok(!JSON.stringify(context).includes("私人完整回答"));
  assert.equal(f.repository.snapshot().audits[0]!.action, "published");
  assert.equal(f.repository.snapshot().versions.length, 1);
});

test("all supported AI kinds require a real saved source owned by the sharing member", async () => {
  const f = setup();
  for (const [sourceKind, sourceId] of [["navigator", "navigator-alice"], ["space_assistant", "assistant-alice"], ["feasibility", "feasibility-alice"]] as const) {
    const result = await f.service.publish(author, PROJECT_ID, f.command({ sourceKind, sourceId }));
    assert.equal(saved(f, result.id).source.sourceKind, sourceKind);
    assert.equal(saved(f, result.id).source.sourceId, sourceId);
  }
  for (const [sourceKind, sourceId] of [["navigator", "invented-answer"], ["navigator", "navigator-bob"], ["space_assistant", "assistant-other-project"], ["feasibility", "navigator-alice"]] as const) {
    await assert.rejects(f.service.publish(author, PROJECT_ID, f.command({ sourceKind, sourceId })), code("SHARE_SOURCE_UNAVAILABLE"));
  }
  f.sources.get("navigator-alice")!.succeeded = false;
  await assert.rejects(publish(f), code("SHARE_SOURCE_UNAVAILABLE"));
  assert.equal(f.repository.snapshot().suggestions.length, 3);
});

test("invalid source-port metadata cannot turn a forged source into an AI card", async () => {
  for (const patch of [{ sourceId: "different-id" }, { sourceKind: "feasibility" as const }, { revision: 0 }, { label: "" }, { label: "x".repeat(121) }]) {
    const f = setup();
    f.sourcePort.verifySource = async () => ({ sourceKind: "navigator", sourceId: "navigator-alice", revision: 1, label: "真实来源", ...patch });
    await assert.rejects(publish(f), code("SHARE_SOURCE_UNAVAILABLE"));
    assert.equal(f.repository.snapshot().suggestions.length, 0);
  }
});

test("manual notes use a fixed member-note label and reject AI source identifiers", async () => {
  const f = setup();
  f.sourcePort.verifySource = async () => ({ sourceKind: "manual", sourceId: null, revision: 1, label: "客户端希望冒充AI" });
  const value = await f.service.publish(author, PROJECT_ID, f.command({ sourceKind: "manual", sourceId: null }));
  assert.deepEqual(saved(f, value.id).source, { sourceKind: "manual", sourceId: null, revision: 1, label: "成员备注" });
  await assert.rejects(f.service.publish(author, PROJECT_ID, f.command({ sourceKind: "manual", sourceId: "navigator-alice" })), code("INVALID_INPUT"));
  assert.equal(f.repository.snapshot().suggestions.length, 1);
});

test("stale edits fail CAS with the latest revision and preserve the prior content and audit", async () => {
  const f = setup(); const first = await publish(f);
  await f.service.edit(author, PROJECT_ID, first.id, { expectedRevision: 1, title: "已更新标题", body: "先完成第一次验证", idempotencyKey: "edit-first" });
  const before = f.repository.snapshot();
  await assert.rejects(f.service.edit(author, PROJECT_ID, first.id, { expectedRevision: 1, title: "旧页面标题", body: "旧输入不覆写", idempotencyKey: "edit-stale" }), code("VERSION_CONFLICT", 2));
  assert.deepEqual(f.repository.snapshot(), before);
  assert.equal(saved(f, first.id).body, "先完成第一次验证");
});

test("two members racing to edit and adopt cannot overwrite each other's successful revision", async () => {
  const f = setup(); const first = await publish(f);
  const results = await Promise.allSettled([
    f.service.edit(author, PROJECT_ID, first.id, { expectedRevision: 1, title: "作者修订", body: "修订后的建议", idempotencyKey: "concurrent-edit" }),
    f.service.adopt(manager, PROJECT_ID, first.id, { expectedRevision: 1, idempotencyKey: "concurrent-adopt" }),
  ]);
  assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
  const rejected = results.find(item => item.status === "rejected");
  assert.ok(rejected?.status === "rejected"); code("VERSION_CONFLICT", 2)(rejected.reason);
  const current = saved(f, first.id);
  assert.equal(current.revision, 2);
  if (results[0]!.status === "fulfilled") { assert.equal(current.body, "修订后的建议"); assert.equal(current.status, "discussion"); }
  else { assert.equal(current.status, "adopted"); assert.equal(current.adoptedByUserId, manager.userId); }
  assert.equal(f.repository.snapshot().audits.length, 2);
  assert.equal(f.repository.snapshot().versions.length, 2);
});

test("concurrent retries with the same key publish once and replay the current receipt", async () => {
  const f = setup(); const command = f.command({ idempotencyKey: "same-publish" });
  const results = await Promise.all([f.service.publish(author, PROJECT_ID, command), f.service.publish(author, PROJECT_ID, command)]);
  assert.equal(results[0]!.id, results[1]!.id);
  assert.deepEqual(results.map(value => value.replayed).sort(), [false, true]);
  assert.equal(f.repository.snapshot().suggestions.length, 1);
  assert.equal(f.repository.snapshot().audits.length, 1);
  assert.equal(f.repository.snapshot().receipts.length, 1);
  await f.service.edit(author, PROJECT_ID, results[0]!.id, { expectedRevision: 1, title: "较新内容", body: "较新正文", idempotencyKey: "newer-edit" });
  const replay = await f.service.publish(author, PROJECT_ID, command);
  assert.equal(replay.revision, 2); assert.equal(replay.replayed, true);
  assert.equal(f.repository.snapshot().audits.length, 2);
});

test("same key with a different payload conflicts without writing a second card", async () => {
  const f = setup(); const command = f.command({ idempotencyKey: "publish-payload" });
  await f.service.publish(author, PROJECT_ID, command); const before = f.repository.snapshot();
  await assert.rejects(f.service.publish(author, PROJECT_ID, { ...command, body: "换了正文" }), code("IDEMPOTENCY_CONFLICT"));
  assert.deepEqual(f.repository.snapshot(), before);
});

test("idempotency scopes isolate actors, projects, actions and target records", async () => {
  const f = setup(); f.addMembership(author, OTHER_PROJECT_ID);
  const first = await f.service.publish(author, PROJECT_ID, f.command({ idempotencyKey: "reused-key" }));
  const second = await f.service.publish(teammate, PROJECT_ID, f.command({ sourceId: "navigator-bob", idempotencyKey: "reused-key" }));
  const otherProject = await f.service.publish(author, OTHER_PROJECT_ID, f.command({ idempotencyKey: "reused-key" }));
  assert.notEqual(first.id, second.id); assert.notEqual(first.id, otherProject.id);
  await f.service.edit(author, PROJECT_ID, first.id, { expectedRevision: 1, title: "已编辑", body: "编辑内容", idempotencyKey: "reused-key" });
  await f.service.withdraw(author, PROJECT_ID, first.id, { expectedRevision: 2, idempotencyKey: "reused-key" });
  await f.service.edit(teammate, PROJECT_ID, second.id, { expectedRevision: 1, title: "另一作者", body: "另一正文", idempotencyKey: "reused-key" });
  assert.equal(f.repository.snapshot().receipts.length, 5);
  assert.equal(f.repository.snapshot(OTHER_PROJECT_ID).receipts.length, 1);
  await assert.rejects(f.service.edit(author, OTHER_PROJECT_ID, first.id, { expectedRevision: 3, title: "跨空间", body: "不能改", idempotencyKey: "cross-project" }), code("NOT_FOUND"));
});

test("only the author may edit or withdraw and only an active project manager may adopt", async () => {
  const f = setup(); const first = await publish(f); const before = f.repository.snapshot();
  for (const actor of [teammate, manager]) {
    await assert.rejects(f.service.edit(actor, PROJECT_ID, first.id, { expectedRevision: 1, title: "他人修改", body: "不允许", idempotencyKey: `edit-${actor.userId}` }), code("SUGGESTION_AUTHOR_REQUIRED"));
    await assert.rejects(f.service.withdraw(actor, PROJECT_ID, first.id, { expectedRevision: 1, idempotencyKey: `withdraw-${actor.userId}` }), code("SUGGESTION_AUTHOR_REQUIRED"));
  }
  await assert.rejects(f.service.adopt(teammate, PROJECT_ID, first.id, { expectedRevision: 1, idempotencyKey: "member-adopt" }), code("PROJECT_MANAGER_REQUIRED"));
  const platformAdmin = { ...teammate, platformRoles: ["admin"] as const };
  await assert.rejects(f.service.adopt(platformAdmin, PROJECT_ID, first.id, { expectedRevision: 1, idempotencyKey: "admin-adopt" }), code("PROJECT_MANAGER_REQUIRED"));
  assert.deepEqual(f.repository.snapshot(), before);
  const adopted = await f.service.adopt(manager, PROJECT_ID, first.id, { expectedRevision: 1, idempotencyKey: "manager-adopt" });
  assert.equal(adopted.status, "adopted");
  assert.equal(saved(f, first.id).adoptedByUserId, manager.userId);
  assert.equal(saved(f, first.id).adoptedAt, NOW);
});

test("editing an adopted decision returns it to discussion and requires a fresh adoption", async () => {
  const f = setup(); const first = await publish(f);
  await f.service.adopt(manager, PROJECT_ID, first.id, { expectedRevision: 1, idempotencyKey: "adopt-first" });
  await assert.rejects(f.service.adopt(manager, PROJECT_ID, first.id, { expectedRevision: 2, idempotencyKey: "adopt-again" }), code("SUGGESTION_ALREADY_ADOPTED"));
  f.setNow("2026-10-09T08:15:00.000Z");
  await f.service.edit(author, PROJECT_ID, first.id, { expectedRevision: 2, title: "调整后的建议", body: "范围缩小，先做核心演示", idempotencyKey: "edit-adopted" });
  const current = saved(f, first.id);
  assert.equal(current.status, "discussion"); assert.equal(current.adoptedAt, null); assert.equal(current.adoptedByUserId, null);
  assert.equal(suggestion(await f.service.listFeed(manager, PROJECT_ID), first.id).canAdopt, true);
  await f.service.adopt(manager, PROJECT_ID, first.id, { expectedRevision: 3, idempotencyKey: "adopt-revised" });
  assert.deepEqual(f.repository.snapshot().audits.map(value => value.action), ["published", "adopted", "edited", "adopted"]);
});

test("withdrawal clears current content, preserves version history and does not read a source again", async () => {
  const f = setup(); const first = await publish(f); f.sources.get("navigator-alice")!.available = false;
  f.sourceCalls.length = 0;
  f.sourcePort.verifySource = async () => { throw new Error("A withdrawal must not read private source content."); };
  const result = await f.service.withdraw(author, PROJECT_ID, first.id, { expectedRevision: 1, idempotencyKey: "withdraw-own" });
  assert.equal(result.status, "withdrawn"); assert.equal(result.revision, 2);
  const current = saved(f, first.id);
  assert.equal(current.title, ""); assert.equal(current.body, ""); assert.equal(current.withdrawnAt, NOW);
  const feed = await f.service.listFeed(teammate, PROJECT_ID);
  assert.deepEqual(feed.items, [{ kind: "unavailable", id: first.id, authorUserId: author.userId, revision: 2, status: "withdrawn", occurredAt: NOW, canWithdraw: false }]);
  assert.deepEqual(await f.service.listSharedContext(teammate, PROJECT_ID), []);
  assert.equal(f.sourceCalls.length, 0);
  const history = f.repository.snapshot().versions;
  assert.equal(history[0]!.body, "本人选择并编辑后共享的建议片段。"); assert.equal(history[1]!.body, "");
  await assert.rejects(f.service.withdraw(author, PROJECT_ID, first.id, { expectedRevision: 2, idempotencyKey: "withdraw-twice" }), code("SUGGESTION_WITHDRAWN"));
  await assert.rejects(f.service.edit(author, PROJECT_ID, first.id, { expectedRevision: 2, title: "不能恢复", body: "旧正文", idempotencyKey: "restore" }), code("SHARE_SOURCE_UNAVAILABLE"));
});

test("revoked or revised sources suppress shared body and are excluded from AI context", async () => {
  for (const change of ["withdraw", "revision"] as const) {
    const f = setup(); const first = await publish(f);
    if (change === "withdraw") f.sources.get("navigator-alice")!.available = false;
    else f.sources.get("navigator-alice")!.revision = 2;
    const feed = await f.service.listFeed(teammate, PROJECT_ID);
    assert.equal(feed.items[0]!.kind, "unavailable");
    assert.ok(!JSON.stringify(feed).includes("本人选择并编辑"));
    assert.deepEqual(await f.service.listSharedContext(teammate, PROJECT_ID), []);
    await assert.rejects(f.service.edit(author, PROJECT_ID, first.id, { expectedRevision: 1, title: "失效后修改", body: "不能用旧来源", idempotencyKey: "edit-unavailable" }), code("SHARE_SOURCE_UNAVAILABLE"));
    await assert.rejects(f.service.adopt(manager, PROJECT_ID, first.id, { expectedRevision: 1, idempotencyKey: "adopt-unavailable" }), code("SHARE_SOURCE_UNAVAILABLE"));
    assert.equal(saved(f, first.id).revision, 1);
  }
});

test("the source owner is taken from the recorded author, never the reading teammate", async () => {
  const f = setup(); const first = await publish(f); f.sourceCalls.length = 0;
  assert.equal(suggestion(await f.service.listFeed(teammate, PROJECT_ID), first.id).source.sourceId, "navigator-alice");
  assert.ok(f.sourceCalls.length > 0);
  assert.ok(f.sourceCalls.every(input => input.ownerUserId === author.userId && input.actor.userId === teammate.userId));
});

test("source changes during asynchronous activity reads are checked before returning a feed", async () => {
  const f = setup(); const first = await publish(f);
  f.hooks.onActivities = () => { f.sources.get("navigator-alice")!.available = false; };
  const feed = await f.service.listFeed(teammate, PROJECT_ID);
  assert.deepEqual(feed.items, [{ kind: "unavailable", id: first.id, authorUserId: author.userId, revision: 1, status: "source_unavailable", occurredAt: NOW, canWithdraw: false }]);
  assert.ok(!JSON.stringify(feed).includes("本人选择并编辑"));
});

test("shared context rechecks sources after assembling candidates", async () => {
  const f = setup(); await publish(f); f.sourceCalls.length = 0;
  f.hooks.onSource = (_input, call) => { if (call === 2) f.sources.get("navigator-alice")!.revision = 2; };
  assert.deepEqual(await f.service.listSharedContext(teammate, PROJECT_ID), []);
  assert.equal(f.sourceCalls.length, 2);
});

test("an unavailable source exposes only an author withdrawal action and read-only spaces suppress it", async () => {
  const f = setup(); const first = await publish(f); f.sources.get("navigator-alice")!.available = false;
  const own = (await f.service.listFeed(author, PROJECT_ID)).items[0]!;
  assert.ok(own.kind === "unavailable"); assert.equal(own.canWithdraw, true);
  assert.equal("body" in own, false); assert.equal("source" in own, false);
  const other = (await f.service.listFeed(manager, PROJECT_ID)).items[0]!;
  assert.ok(other.kind === "unavailable"); assert.equal(other.canWithdraw, false);
  f.readOnlyProjects.add(PROJECT_ID);
  const archived = (await f.service.listFeed(author, PROJECT_ID)).items[0]!;
  assert.ok(archived.kind === "unavailable"); assert.equal(archived.canWithdraw, false);
  assert.equal(archived.id, first.id);
});

test("source revision or withdrawal between mutation checks rolls back cards, audit and receipt", async () => {
  for (const change of ["withdraw", "revision"] as const) {
    const f = setup();
    f.hooks.onSource = (_input, call) => {
      if (call !== 2) return;
      if (change === "withdraw") f.sources.get("navigator-alice")!.available = false;
      else f.sources.get("navigator-alice")!.revision += 1;
    };
    await assert.rejects(publish(f), code("SHARE_SOURCE_UNAVAILABLE"));
    assert.deepEqual(f.repository.snapshot(), { suggestions: [], audits: [], versions: [], receipts: [] });
    assert.equal(f.repository.rollbacks, 1);
  }
});

test("editing and adopting recheck source revision before persisted changes", async () => {
  for (const action of ["edit", "adopt"] as const) {
    const f = setup(); const first = await publish(f); f.sourceCalls.length = 0;
    const before = f.repository.snapshot();
    f.hooks.onSource = (_input, call) => { if (call === 2) f.sources.get("navigator-alice")!.revision += 1; };
    const request = action === "edit"
      ? f.service.edit(author, PROJECT_ID, first.id, { expectedRevision: 1, title: "待写新内容", body: "待写新正文", idempotencyKey: "edit-source-race" })
      : f.service.adopt(manager, PROJECT_ID, first.id, { expectedRevision: 1, idempotencyKey: "adopt-source-race" });
    await assert.rejects(request, code("SHARE_SOURCE_UNAVAILABLE"));
    assert.deepEqual(f.repository.snapshot(), before);
  }
});

test("removed or left members and disabled accounts cannot read, write or replay cached receipts", async () => {
  for (const state of ["removed", "left", "disabled"] as const) {
    const f = setup(); const command = f.command({ idempotencyKey: "receipt-before-revoke" });
    const first = await f.service.publish(author, PROJECT_ID, command); const before = f.repository.snapshot();
    if (state === "disabled") f.disabledAccounts.add(author.userId); else f.membership(author).status = state;
    await assert.rejects(f.service.listFeed(author, PROJECT_ID), code("PROJECT_ACCESS_DENIED"));
    await assert.rejects(f.service.listSharedContext(author, PROJECT_ID), code("PROJECT_ACCESS_DENIED"));
    await assert.rejects(f.service.publish(author, PROJECT_ID, command), code("PROJECT_ACCESS_DENIED"));
    await assert.rejects(f.service.withdraw(author, PROJECT_ID, first.id, { expectedRevision: 1, idempotencyKey: "withdraw-revoked" }), code("PROJECT_ACCESS_DENIED"));
    assert.deepEqual(f.repository.snapshot(), before);
  }
});

test("archived spaces remain readable and expose no write controls or mutation path", async () => {
  const f = setup(); const command = f.command({ idempotencyKey: "before-archive" });
  const first = await f.service.publish(author, PROJECT_ID, command); f.readOnlyProjects.add(PROJECT_ID);
  const feed = await f.service.listFeed(author, PROJECT_ID);
  assert.equal(feed.readOnly, true);
  const card = suggestion(feed, first.id);
  assert.equal(card.canEdit, false); assert.equal(card.canWithdraw, false); assert.equal(card.canAdopt, false);
  assert.equal((await f.service.listSharedContext(teammate, PROJECT_ID)).length, 1);
  for (const request of [
    f.service.publish(author, PROJECT_ID, command),
    f.service.edit(author, PROJECT_ID, first.id, { expectedRevision: 1, title: "归档修改", body: "不可写", idempotencyKey: "archived-edit" }),
    f.service.withdraw(author, PROJECT_ID, first.id, { expectedRevision: 1, idempotencyKey: "archived-withdraw" }),
    f.service.adopt(manager, PROJECT_ID, first.id, { expectedRevision: 1, idempotencyKey: "archived-adopt" }),
  ]) await assert.rejects(request, code("PROJECT_READ_ONLY"));
  assert.equal(f.repository.snapshot().audits.length, 1);
});

test("permission loss before a feed or AI context returns discards the whole read", async () => {
  for (const read of ["feed", "context"] as const) {
    const f = setup(); await publish(f); f.accessCalls.length = 0; const before = f.repository.snapshot();
    f.hooks.onAccess = (_input, call) => { if (call === 2) f.membership(teammate).status = "removed"; };
    await assert.rejects(read === "feed" ? f.service.listFeed(teammate, PROJECT_ID) : f.service.listSharedContext(teammate, PROJECT_ID), code("PROJECT_ACCESS_DENIED"));
    assert.deepEqual(f.repository.snapshot(), before);
    assert.equal(f.repository.rollbacks, 1);
  }
});

test("membership identity, role or archive changes during reads cannot return stale controls", async () => {
  for (const change of ["membership", "role", "archive"] as const) {
    const f = setup(); await publish(f);
    f.hooks.onActivities = () => {
      if (change === "membership") f.membership(teammate).membershipId = "rejoined-membership";
      if (change === "role") f.membership(teammate).role = "manager";
      if (change === "archive") f.readOnlyProjects.add(PROJECT_ID);
    };
    await assert.rejects(f.service.listFeed(teammate, PROJECT_ID), code("PROJECT_ACCESS_DENIED"));
  }
});

test("permission revocation or archive before a publish commits rolls back the mutation", async () => {
  for (const change of ["removed", "archive", "membership"] as const) {
    const f = setup();
    f.hooks.onAccess = (_input, call) => {
      if (call !== 2) return;
      if (change === "removed") f.membership(author).status = "removed";
      if (change === "archive") f.readOnlyProjects.add(PROJECT_ID);
      if (change === "membership") f.membership(author).membershipId = "new-active-membership";
    };
    await assert.rejects(publish(f), code(change === "archive" ? "PROJECT_READ_ONLY" : "PROJECT_ACCESS_DENIED"));
    assert.equal(f.repository.snapshot().suggestions.length, 0);
    assert.equal(f.repository.snapshot().receipts.length, 0);
  }
});

test("transaction failure after tentative writes rolls back content, history and idempotency", async () => {
  const f = setup(); const command = f.command({ idempotencyKey: "retry-rollback" });
  f.repository.beforeCommit = () => { throw new Error("simulated commit failure"); };
  await assert.rejects(f.service.publish(author, PROJECT_ID, command), /simulated commit failure/);
  assert.deepEqual(f.repository.snapshot(), { suggestions: [], audits: [], versions: [], receipts: [] });
  f.repository.beforeCommit = undefined;
  const result = await f.service.publish(author, PROJECT_ID, command);
  assert.equal(result.replayed, false);
  assert.equal(f.repository.snapshot().audits.length, 1);
});

test("M05 done without a check stays waiting for review and read projections never write M05", async () => {
  const f = setup();
  f.activities.push(taskActivity({ status: "done", checked: false }), taskActivity({ id: "progress-2", taskId: "m05-task-2", status: "done", checked: true }));
  const sourceActivities = structuredClone(f.activities);
  const feed = await f.service.listFeed(teammate, PROJECT_ID);
  const unchecked = feed.items.find(item => item.id === "progress-1"); const checked = feed.items.find(item => item.id === "progress-2");
  assert.ok(unchecked?.kind === "task"); assert.equal(unchecked.status, "review"); assert.equal(unchecked.checked, false);
  assert.ok(checked?.kind === "task"); assert.equal(checked.status, "done"); assert.equal(checked.checked, true);
  assert.deepEqual(f.activities, sourceActivities);
  assert.equal(f.activityCalls.length, 1);
  assert.deepEqual(f.repository.sqlQueries, []);
  assert.deepEqual(f.repository.snapshot(), { suggestions: [], audits: [], versions: [], receipts: [] });
  assert.deepEqual(await f.service.listSharedContext(teammate, PROJECT_ID), []);
  assert.equal(f.activityCalls.length, 1);
});

test("feed sorts real suggestions and task activities by occurrence, limits output and ignores invalid dates", async () => {
  const f = setup(); const first = await publish(f);
  f.activities.push(taskActivity({ id: "new-progress", occurredAt: "2026-10-09T09:00:00.000Z" }), taskActivity({ id: "old-progress", occurredAt: "2026-10-09T07:00:00.000Z" }), taskActivity({ id: "bad-progress", occurredAt: "invalid-date" }));
  const feed = await f.service.listFeed(teammate, PROJECT_ID, { limit: 2 });
  assert.deepEqual(feed.items.map(item => item.id), ["new-progress", first.id]);
  assert.equal(feed.checkedAt, NOW); assert.equal(f.activityCalls[0]!.limit, 2);
  for (const limit of [0, 101, 1.5, NaN]) await assert.rejects(f.service.listFeed(teammate, PROJECT_ID, { limit }), code("INVALID_INPUT"));
});

test("one transaction executor is passed to current access, source and read-only activity ports", async () => {
  const f = setup(); await publish(f);
  f.accessCalls.length = 0; f.sourceCalls.length = 0;
  await f.service.listFeed(teammate, PROJECT_ID);
  const executor = f.repository.executors.at(-1);
  assert.ok(executor);
  assert.ok(f.accessCalls.every(input => input.transaction === executor));
  assert.ok(f.sourceCalls.every(input => input.transaction === executor));
  assert.ok(f.activityCalls.every(input => input.transaction === executor));
});

test("AI shared context defaults to ten cards, caps at twenty and bounds UTF-8 content bytes", async () => {
  const f = setup();
  for (let index = 0; index < 24; index += 1) await f.service.publish(author, PROJECT_ID, f.command({ title: `建议 ${index}` }));
  assert.equal((await f.service.listSharedContext(teammate, PROJECT_ID)).length, 10);
  assert.equal((await f.service.listSharedContext(teammate, PROJECT_ID, { limit: 100 })).length, 20);
  const large = setup();
  for (let index = 0; index < 8; index += 1) await large.service.publish(author, PROJECT_ID, large.command({ title: `长建议 ${index}`, body: "汉".repeat(6000) }));
  const context = await large.service.listSharedContext(teammate, PROJECT_ID, { limit: 20 });
  assert.ok(context.length > 0 && context.length < 8);
  assert.ok(context.reduce((bytes, value) => bytes + Buffer.byteLength(JSON.stringify(value), "utf8"), 0) <= 32768);
  assert.ok(Buffer.byteLength(JSON.stringify(context), "utf8") <= 32768);
});

test("input bounds reject empty or oversized snippets, invalid revisions and missing operation keys", async () => {
  const f = setup();
  for (const patch of [{ title: " " }, { title: "x".repeat(121) }, { body: "x".repeat(6001) }, { body: "内容\u0000" }, { idempotencyKey: "" }]) {
    await assert.rejects(f.service.publish(author, PROJECT_ID, f.command(patch)), code("INVALID_INPUT"));
  }
  const first = await publish(f);
  for (const expectedRevision of [0, -1, 1.5, NaN]) await assert.rejects(f.service.withdraw(author, PROJECT_ID, first.id, { expectedRevision, idempotencyKey: "bad-revision" }), code("INVALID_INPUT"));
  assert.equal(f.repository.snapshot().suggestions.length, 1);
});
