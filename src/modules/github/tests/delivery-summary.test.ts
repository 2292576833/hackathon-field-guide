import assert from "node:assert/strict";
import test from "node:test";
import type { Actor } from "../../../shared/contracts.ts";
import { getDeliverySummary } from "../delivery-summary.ts";
import type { DeliveryService } from "../delivery-service.ts";
import type { GitService } from "../git-service.ts";
import type { DeliveryVerification, GitOperation, SubmissionRecord } from "../types.ts";
import type { DeliveryMaterialsService } from "../delivery-materials-service.ts";
import type { ConfirmedDeliveryRequirements, DeliveryMaterialChecklist } from "../delivery-materials-types.ts";

const actor: Actor = { userId: "summary-user", platformRoles: ["user"] };
const projectId = "summary-project";
const oldCommit = "a".repeat(40);
const currentCommit = "b".repeat(40);
const anotherCommit = "c".repeat(40);

function operation(id: string, status: GitOperation["status"], commitSha: string | null, createdAt: string): GitOperation {
  return {
    id, projectId, actorId: actor.userId, bindingId: "summary-binding", bindingRevision: 1,
    target: { repositoryId: 1, owner: "fixture-team", name: "fixture-repository", installationId: 2, appId: 3, defaultBranch: "main" },
    idempotencyKey: `fixture-${id}`, inputHash: "fixture-input-hash", manifest: { entries: [], totalBytes: 0, inputHash: "fixture-input-hash", issues: [] },
    draftRef: `fixture-draft-${id}`, expiresAt: "2026-10-09T00:00:00.000Z", message: "测试版本", wantsPullRequest: false,
    branch: `hackathon/${id}`, status, step: status === "saved" ? "done" : "draft", revision: 1, createdAt, updatedAt: createdAt,
    preview: null, treeSha: commitSha ? "d".repeat(40) : null, commitSha, commitMessage: null,
    pullRequestUrl: null, pullRequestStatus: "not_requested", errorCode: null, leaseUntil: null,
  };
}

function verification(id: string, repositoryCommitSha: string | null, outcome: DeliveryVerification["outcome"], verifiedAt: string): DeliveryVerification {
  return {
    id, projectId, repositoryCommitSha, verifierId: actor.userId, verifiedAt, environmentSummary: "测试环境",
    steps: ["运行演示流程"], outcome, blockers: outcome === "passed" ? [] : ["需继续核对"],
    evidenceRefs: [`fixture-evidence:${id}`], verificationSource: "user_reported", version: 1,
  };
}

/** Independently supplied read-only ports. They do not create repository, runtime or submission facts. */
function fixture(operations: GitOperation[], verifications: DeliveryVerification[], submissions: SubmissionRecord[] = []) {
  const calls: string[] = [];
  const assertRequest = (receivedActor: Actor, receivedProject: string) => {
    assert.equal(receivedActor, actor);
    assert.equal(receivedProject, projectId);
  };
  const git = {
    async listOperations(receivedActor: Actor, receivedProject: string): Promise<GitOperation[]> {
      assertRequest(receivedActor, receivedProject); calls.push("operations"); return structuredClone(operations);
    },
  } as unknown as GitService;
  const delivery = {
    async listVerifications(receivedActor: Actor, receivedProject: string): Promise<DeliveryVerification[]> {
      assertRequest(receivedActor, receivedProject); calls.push("verifications"); return structuredClone(verifications);
    },
    async listSubmissions(receivedActor: Actor, receivedProject: string): Promise<SubmissionRecord[]> {
      assertRequest(receivedActor, receivedProject); calls.push("submissions"); return structuredClone(submissions);
    },
  } as unknown as DeliveryService;
  return { read: () => getDeliverySummary(actor, projectId, { git, delivery }), calls };
}

test("旧commit通过后保存新commit，当前仍未验收且保留旧验收历史", async () => {
  const historical = verification("old-passed", oldCommit, "passed", "2026-10-08T02:00:00.000Z");
  const f = fixture([
    operation("old-save", "saved", oldCommit, "2026-10-08T01:00:00.000Z"),
    operation("new-save", "saved", currentCommit, "2026-10-08T03:00:00.000Z"),
  ], [historical]);
  const summary = await f.read();
  assert.equal(summary.runtime.currentCommitSha, currentCommit);
  assert.equal(summary.runtime.status, "not_verified");
  assert.equal(summary.runtime.matchStatus, "no_matching_verification");
  assert.equal(summary.runtime.latestVerification, null);
  assert.deepEqual(summary.runtime.latestHistoricalVerification, historical);
  assert.deepEqual(summary.runtime.verificationHistory, [historical]);
  assert.deepEqual(summary.submission.records, []);
  assert.deepEqual(f.calls.sort(), ["operations", "submissions", "verifications"]);
});

for (const outcome of ["passed", "failed", "inconclusive"] as const) {
  test(`当前commit匹配验收结论${outcome}，使用最新同SHA事实而不推导正式提交`, async () => {
    const earlier = verification("matching-earlier", currentCommit, outcome === "passed" ? "failed" : "passed", "2026-10-08T02:00:00.000Z");
    const latest = verification("matching-latest", currentCommit, outcome, "2026-10-08T04:00:00.000Z");
    const summary = await fixture([operation("current-save", "saved", currentCommit, "2026-10-08T01:00:00.000Z")], [earlier, latest]).read();
    assert.equal(summary.runtime.currentCommitSha, currentCommit);
    assert.equal(summary.runtime.matchStatus, "matched");
    assert.equal(summary.runtime.status, outcome);
    assert.deepEqual(summary.runtime.latestVerification, latest);
    assert.deepEqual(summary.runtime.latestHistoricalVerification, latest);
    assert.deepEqual(summary.runtime.verificationHistory, [latest, earlier]);
    assert.deepEqual(summary.submission.records, []);
    assert.equal(summary.submission.platformConfirmationAvailable, false);
  });
}

test("更晚其他commit与nullSHA验收只更新历史，不覆盖当前匹配结论", async () => {
  const matching = verification("current-failed", currentCommit, "failed", "2026-10-08T02:00:00.000Z");
  const other = verification("other-passed", anotherCommit, "passed", "2026-10-08T03:00:00.000Z");
  const unassociated = verification("unassociated-passed", null, "passed", "2026-10-08T04:00:00.000Z");
  const summary = await fixture([operation("current-save", "saved", currentCommit, "2026-10-08T01:00:00.000Z")], [other, matching, unassociated]).read();
  assert.equal(summary.runtime.status, "failed");
  assert.equal(summary.runtime.matchStatus, "matched");
  assert.deepEqual(summary.runtime.latestVerification, matching);
  assert.deepEqual(summary.runtime.latestHistoricalVerification, unassociated);
  assert.deepEqual(summary.runtime.verificationHistory, [unassociated, other, matching]);
});

test("当前SHA的同时间验收按id降序选择，历史列表也按时间和id排序", async () => {
  const earlier = verification("verification-z-older", currentCommit, "passed", "2026-10-08T02:00:00.000Z");
  const tieA = verification("verification-a", currentCommit, "passed", "2026-10-08T03:00:00.000Z");
  const tieZ = verification("verification-z", currentCommit, "inconclusive", "2026-10-08T03:00:00.000Z");
  const summary = await fixture([operation("current-save", "saved", currentCommit, "2026-10-08T01:00:00.000Z")], [tieA, earlier, tieZ]).read();
  assert.equal(summary.runtime.status, "inconclusive");
  assert.deepEqual(summary.runtime.latestVerification, tieZ);
  assert.deepEqual(summary.runtime.latestHistoricalVerification, tieZ);
  assert.deepEqual(summary.runtime.verificationHistory, [tieZ, tieA, earlier]);
});

test("没有已保存commit时即使历史通过也保持unknown；nullSHA事实不能作为当前通过", async () => {
  const historical = verification("historical-passed", oldCommit, "passed", "2026-10-08T02:00:00.000Z");
  const unassociated = verification("unassociated-passed", null, "passed", "2026-10-08T03:00:00.000Z");
  for (const operations of [[], [operation("unknown-operation", "unknown", oldCommit, "2026-10-08T01:00:00.000Z")], [operation("draft-operation", "draft", oldCommit, "2026-10-08T01:00:00.000Z")]]) {
    const summary = await fixture(operations, [historical, unassociated]).read();
    assert.equal(summary.runtime.currentCommitSha, null);
    assert.equal(summary.runtime.status, "unknown");
    assert.equal(summary.runtime.matchStatus, "no_saved_commit");
    assert.equal(summary.runtime.latestVerification, null);
    assert.deepEqual(summary.runtime.latestHistoricalVerification, unassociated);
    assert.deepEqual(summary.runtime.verificationHistory, [unassociated, historical]);
  }
});

test("最新saved缺少SHA时保持unknown，不退回更旧saved或历史通过", async () => {
  const historical = verification("historical-passed", oldCommit, "passed", "2026-10-08T02:00:00.000Z");
  const summary = await fixture([
    operation("older-save", "saved", oldCommit, "2026-10-08T01:00:00.000Z"),
    operation("latest-save-missing-sha", "saved", null, "2026-10-08T03:00:00.000Z"),
  ], [historical]).read();
  assert.equal(summary.repository.latestSavedOperation?.id, "latest-save-missing-sha");
  assert.equal(summary.runtime.currentCommitSha, null);
  assert.equal(summary.runtime.status, "unknown");
  assert.equal(summary.runtime.matchStatus, "no_saved_commit");
  assert.equal(summary.runtime.latestVerification, null);
  assert.deepEqual(summary.runtime.latestHistoricalVerification, historical);
  assert.deepEqual(summary.runtime.verificationHistory, [historical]);
});

for (const status of ["draft", "unknown"] as const) {
  test(`新的${status}操作不替换已保存commit对应的真实验收`, async () => {
    const matching = verification("saved-passed", currentCommit, "passed", "2026-10-08T02:00:00.000Z");
    const newVersionFailed = verification("new-unsaved-failed", anotherCommit, "failed", "2026-10-08T04:00:00.000Z");
    const summary = await fixture([
      operation("new-unsaved", status, anotherCommit, "2026-10-08T03:00:00.000Z"),
      operation("real-saved", "saved", currentCommit, "2026-10-08T01:00:00.000Z"),
    ], [matching, newVersionFailed]).read();
    assert.equal(summary.repository.status, status);
    assert.equal(summary.repository.latestOperation?.id, "new-unsaved");
    assert.equal(summary.repository.latestSavedOperation?.id, "real-saved");
    assert.equal(summary.runtime.currentCommitSha, currentCommit);
    assert.equal(summary.runtime.status, "passed");
    assert.equal(summary.runtime.matchStatus, "matched");
    assert.deepEqual(summary.runtime.latestVerification, matching);
    assert.deepEqual(summary.runtime.latestHistoricalVerification, newVersionFailed);
    assert.deepEqual(summary.runtime.verificationHistory, [newVersionFailed, matching]);
  });
}

test("保存commit但只有nullSHA通过历史时当前仍未验收", async () => {
  const unassociated = verification("unassociated-passed", null, "passed", "2026-10-08T02:00:00.000Z");
  const summary = await fixture([operation("real-saved", "saved", currentCommit, "2026-10-08T01:00:00.000Z")], [unassociated]).read();
  assert.equal(summary.runtime.currentCommitSha, currentCommit);
  assert.equal(summary.runtime.status, "not_verified");
  assert.equal(summary.runtime.matchStatus, "no_matching_verification");
  assert.equal(summary.runtime.latestVerification, null);
  assert.deepEqual(summary.runtime.latestHistoricalVerification, unassociated);
});

test("真实材料Port按当前saved代码核对，材料准备不能推导运行或正式提交", async () => {
  const requirements: ConfirmedDeliveryRequirements = { projectId, eventId: "confirmed-event", requirementsVersion: "confirmed-event:1:1", confirmedAt: "2026-10-08T00:00:00.000Z", materialsStatus: "specified", materials: [{ id: "demo", label: "演示视频", stageId: "final", necessity: "required", evidenceRefs: ["official-evidence"] }], requiredBranch: { status: "not_required", evidenceRefs: ["official-evidence"] }, stages: [], unknowns: [] };
  const current: DeliveryMaterialChecklist = { id: "materials-1", projectId, version: 1, eventId: requirements.eventId, requirementsVersion: requirements.requirementsVersion, repositoryCommitSha: currentCommit, entries: [{ requirementId: "demo", location: "demo/final.mp4", revision: "revision-1", repositoryCommitSha: currentCommit, verification: { outcome: "passed", verifiedAt: "2026-10-08T02:00:00.000Z", verifiedBy: actor.userId, evidenceRefs: ["actual-manual-review"], note: "已观看", verificationSource: "user_reported" } }], branchVerification: null, recordedBy: actor.userId, recordedAt: "2026-10-08T02:00:00.000Z", idempotencyKey: "materials-key", inputHash: "fixture-input-hash" };
  const operations = [operation("current-save", "saved", currentCommit, "2026-10-08T01:00:00.000Z")];
  let reads = 0;
  const materials = { async read(receivedActor: Actor, receivedProject: string) { assert.equal(receivedActor, actor); assert.equal(receivedProject, projectId); reads++; return { requirements, current, history: [current] }; } } as unknown as DeliveryMaterialsService;
  const services = { git: { async listOperations() { return operations; } } as unknown as GitService, delivery: { async listVerifications() { return []; }, async listSubmissions() { return []; } } as unknown as DeliveryService, materials };
  const summary = await getDeliverySummary(actor, projectId, services);
  assert.equal(reads, 1); assert.equal(summary.requirements.status, "ready"); assert.equal(summary.requirements.materials[0].status, "prepared");
  assert.equal(summary.runtime.status, "not_verified"); assert.deepEqual(summary.submission.records, []); assert.equal(summary.submission.platformConfirmationAvailable, false);
  operations.unshift(operation("new-current-save", "saved", anotherCommit, "2026-10-08T03:00:00.000Z"));
  const changed = await getDeliverySummary(actor, projectId, services); assert.equal(changed.requirements.status, "needs_review"); assert.equal(changed.requirements.materials[0].status, "outdated");
});
