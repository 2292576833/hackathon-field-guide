import { test } from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../../../shared/errors.ts";
import type { Actor } from "../../../shared/contracts.ts";
import type { CommitData, FileChange, GitHead, GitOperation, GitRepositoryStore, GitServiceDependencies, GitTreeEntry, RepositoryBinding, RepositoryTarget, UserCredential } from "../types.ts";
import { GitService } from "../git-service.ts";

const actor: Actor = { userId: "user-a", platformRoles: ["user"] };
const base = "a".repeat(40), treeBase = "b".repeat(40), treeNew = "c".repeat(40), commitNew = "d".repeat(40);
const target: RepositoryTarget = { repositoryId: 1, owner: "team", name: "repo", installationId: 2, appId: 3, defaultBranch: "main" };
const clone = <T>(value: T): T => structuredClone(value);
class FixtureStore implements GitRepositoryStore {
  binding: RepositoryBinding | null = { ...target, id: "binding-1", projectId: "project-a", boundBy: actor.userId, status: "bound", revision: 1, checkedAt: "2026-10-08T00:00:00.000Z" };
  operations = new Map<string, GitOperation>();
  async getBinding(projectId: string) { return this.binding?.projectId === projectId ? clone(this.binding) : null; }
  async saveBinding(binding: RepositoryBinding, expected: number | null) {
    if ((this.binding?.revision ?? null) !== expected) throw new DomainError("VERSION_CONFLICT", "conflict", { status: 409 });
    this.binding = clone(binding);
  }
  async createOperation(operation: GitOperation) {
    const old = [...this.operations.values()].find(value => value.projectId === operation.projectId && value.actorId === operation.actorId && value.idempotencyKey === operation.idempotencyKey);
    if (old) { if (old.inputHash !== operation.inputHash) throw new DomainError("IDEMPOTENCY_KEY_REUSED", "conflict", { status: 409 }); return clone(old); }
    this.operations.set(operation.id, clone(operation)); return clone(operation);
  }
  async getOperation(projectId: string, id: string) { const operation = this.operations.get(id); return operation?.projectId === projectId ? clone(operation) : null; }
  async findOperationByKey(projectId: string, actorId: string, key: string) { return clone([...this.operations.values()].find(operation => operation.projectId === projectId && operation.actorId === actorId && operation.idempotencyKey === key) ?? null); }
  async listOperations(projectId: string) { return clone([...this.operations.values()].filter(operation => operation.projectId === projectId)); }
  async updateOperation(operation: GitOperation, expected: number) {
    if (this.operations.get(operation.id)?.revision !== expected) throw new DomainError("VERSION_CONFLICT", "conflict", { status: 409 });
    this.operations.set(operation.id, clone(operation));
  }
}
function fixture() {
  const store = new FixtureStore();
  const state = {
    active: true, manager: true, save: true, push: true, appWrite: true, prWrite: true,
    credentialOwner: actor.userId, now: new Date("2026-10-08T00:00:00.000Z"), draftQuotaFull: false,
    head: { commitSha: base, treeSha: treeBase } as GitHead,
    tree: [{ path: "README.md", type: "blob", mode: "100644", sha: "e".repeat(40) }, { path: "keep.txt", type: "blob", mode: "100644", sha: "f".repeat(40) }] as GitTreeEntry[],
    branch: new Map<string, string>(), commits: new Map<string, CommitData>(), drafts: new Map<string, FileChange[]>(),
    writes: { tree: 0, commit: 0, branch: 0, pr: 0 }, writtenChanges: [] as FileChange[], writtenBase: "", lostBranch: false, lostCommit: false, prError: false, commitDenied: false, prUnknown: false, prLookupFails: false,
    beforeCommit: async () => {}, afterCommit: () => {}, onGetCommit: () => {},
  };
  let id = 0;
  const d: GitServiceDependencies = {
    store, clock: { now: () => new Date(state.now) }, ids: { next: () => `op-${++id}` },
    access: { async getMembership(projectId, userId) { return state.active && projectId === "project-a" ? { projectId, userId, status: "active", role: state.manager ? "manager" : "member", membershipId: "member-1" } : null; } },
    capabilities: { async getCapabilities() { return { saveRepository: state.save, verifyDelivery: true, recordSubmission: true }; } },
    credentials: { async getUserCredential() { return { token: "fixture-server-only", tokenKind: "github_app_user", websiteUserId: state.credentialOwner, githubUserId: 42 }; } },
    drafts: {
      async put(input) { if (state.draftQuotaFull) throw new DomainError("DRAFT_QUOTA_EXCEEDED", "quota", { status: 429 }); const ref = `draft-${++id}`; state.drafts.set(ref, clone(input.changes)); return ref; },
      async get(ref) { return clone(state.drafts.get(ref) ?? null); }, async remove(ref) { state.drafts.delete(ref); }, async purgeExpired() { return 0; },
    },
    github: {
      async authorize() { return { githubUserId: 42, contentsWrite: state.appWrite, userCanPush: state.push, pullRequestsWrite: state.prWrite }; },
      async getHead(_credential, _target, branch) { if (branch === "main") return clone(state.head); const sha = state.branch.get(branch); return sha ? { commitSha: sha, treeSha: treeNew } : null; },
      async getTree() { return clone(state.tree); }, async getBlobText() { return "old text\n"; },
      async createTree(_credential, _target, baseTreeSha, changes) { state.writes.tree++; state.writtenBase = baseTreeSha; state.writtenChanges = clone(changes); return treeNew; },
      async createCommit(_credential, _target, input) {
        await state.beforeCommit(); if (state.commitDenied) throw new DomainError("GITHUB_PERMISSION_DENIED", "denied", { status: 403 }); state.writes.commit++;
        state.commits.set(commitNew, { sha: commitNew, treeSha: input.treeSha, parents: [input.parentSha], message: input.message }); state.afterCommit();
        if (state.lostCommit) throw Object.assign(new DomainError("GITHUB_OUTCOME_UNKNOWN", "unknown", { status: 503 }), { outcomeUnknown: true });
        return commitNew;
      },
      async getCommit(_credential, _target, sha) { const result = state.commits.get(sha); assert.ok(result); state.onGetCommit(); return clone(result); },
      async createBranch(_credential, _target, branch, sha) { state.writes.branch++; state.branch.set(branch, sha); if (state.lostBranch) throw Object.assign(new DomainError("GITHUB_OUTCOME_UNKNOWN", "unknown", { status: 503 }), { outcomeUnknown: true }); },
      async findPullRequest() { if (state.prLookupFails) throw new DomainError("GITHUB_SERVICE_UNAVAILABLE", "unavailable", { status: 503 }); return null; },
      async createPullRequest() { state.writes.pr++; if (state.prUnknown) throw Object.assign(new DomainError("GITHUB_OUTCOME_UNKNOWN", "unknown", { status: 503 }), { outcomeUnknown: true }); if (state.prError) throw new DomainError("GITHUB_FORBIDDEN", "denied", { status: 403 }); return "https://github.com/team/repo/pull/1"; },
    },
  };
  const service = new GitService(d);
  async function ready(wantsPullRequest = false, changes: FileChange[] = [{ path: "README.md", action: "upsert", content: "new text\n" }]) {
    const draft = await service.createDraft(actor, "project-a", { changes, idempotencyKey: "key-00001", message: "保存作品", wantsPullRequest });
    return service.preview(actor, "project-a", draft.id);
  }
  return { service, store, state, ready };
}

test("one selected multi-file tree uses base_tree and a single commit on an independent branch", async () => {
  const f = fixture();
  const operation = await f.ready(false, [{ path: "README.md", action: "upsert", content: "new\n" }, { path: "src/index.ts", action: "upsert", content: "export const answer = 42;\n" }]);
  const result = await f.service.confirm(actor, "project-a", operation.id, operation.preview!.previewHash);
  assert.equal(result.status, "saved"); assert.equal(f.state.writtenBase, treeBase); assert.equal(f.state.writtenChanges.length, 2);
  assert.deepEqual(f.state.writes, { tree: 1, commit: 1, branch: 1, pr: 0 }); assert.equal(f.state.head.commitSha, base);
  assert.deepEqual(f.state.commits.get(commitNew)?.parents, [base]); assert.match(result.branch, /^hackathon\/[0-9a-f]{32}$/);
  const repeat = await f.service.confirm(actor, "project-a", operation.id, "old hash"); assert.equal(repeat.status, "saved"); assert.equal(f.state.writes.commit, 1);
});

test("preserve executable mode when the user only changes file contents", async () => {
  const f = fixture(); f.state.tree[0]!.mode = "100755";
  const operation = await f.ready(); await f.service.confirm(actor, "project-a", operation.id, operation.preview!.previewHash);
  assert.equal(f.state.writtenChanges[0]!.mode, "100755");
});

test("same scoped key returns existing draft; different contents fail and clean the orphan", async () => {
  const f = fixture(); const input = { changes: [{ path: "a.txt", action: "upsert" as const, content: "a" }], idempotencyKey: "idempotent-1", message: "save" };
  const one = await f.service.createDraft(actor, "project-a", input); const two = await f.service.createDraft(actor, "project-a", input);
  assert.equal(one.id, two.id); assert.equal(f.state.drafts.size, 1);
  f.state.draftQuotaFull = true;
  assert.equal((await f.service.createDraft(actor, "project-a", input)).id, one.id);
  await assert.rejects(f.service.createDraft(actor, "project-a", { ...input, message: "changed" }), { code: "IDEMPOTENCY_KEY_REUSED" }); assert.equal(f.state.drafts.size, 1);
});

test("current membership, explicit capability, website identity and actual GitHub write intersect", async () => {
  for (const field of ["active", "save", "push", "appWrite"] as const) {
    const f = fixture(); const operation = await f.ready(); f.state[field] = false;
    await assert.rejects(f.service.confirm(actor, "project-a", operation.id, operation.preview!.previewHash)); assert.equal(f.state.writes.tree, 0);
  }
  const f = fixture(); const operation = await f.ready(); f.state.credentialOwner = "other-user";
  await assert.rejects(f.service.confirm(actor, "project-a", operation.id, operation.preview!.previewHash), { code: "GITHUB_USER_AUTHORIZATION_REQUIRED" });
  await assert.rejects(f.service.getOperation(actor, "other-project", operation.id), { code: "PROJECT_NOT_FOUND" });
  await assert.rejects(f.service.confirm({ ...actor, userId: "user-b" }, "project-a", operation.id, operation.preview!.previewHash), { code: "OPERATION_NOT_FOUND" });
});

test("a team member cannot bind a repository without current project manager membership", async () => {
  const f = fixture(); f.state.manager = false;
  await assert.rejects(f.service.bindRepository(actor, "project-a", target, 1), { code: "PROJECT_MANAGER_REQUIRED" });
  f.state.manager = true; f.state.push = false;
  await assert.rejects(f.service.bindRepository(actor, "project-a", target, 1), { code: "GITHUB_WRITE_FORBIDDEN" });
});

test("binding rejects extra nested credentials instead of persisting or returning them", async () => {
  const f = fixture();
  await assert.rejects(f.service.bindRepository(actor, "project-a", { ...target, token: "private-extra" } as RepositoryTarget, 1), { code: "INVALID_REPOSITORY" });
  assert.doesNotMatch(JSON.stringify(f.store.binding), /private-extra/);
});

test("preview confirmation binds the exact operation, message and PR choice", async () => {
  const f = fixture(); const first = await f.ready();
  const draft = await f.service.createDraft(actor, "project-a", { changes: [{ path: "README.md", action: "upsert", content: "new text\n" }], idempotencyKey: "key-00002", message: "另一份保存说明", wantsPullRequest: true });
  const second = await f.service.preview(actor, "project-a", draft.id);
  assert.notEqual(first.preview!.previewHash, second.preview!.previewHash);
  await assert.rejects(f.service.confirm(actor, "project-a", second.id, first.preview!.previewHash), { code: "PREVIEW_CONFIRMATION_REQUIRED" });
});

test("draft download remains owner-only and recovers content independently of GitHub write permission", async () => {
  const f = fixture(); const operation = await f.ready(); f.state.push = false;
  assert.deepEqual(await f.service.getDraftFiles(actor, "project-a", operation.id), [{ path: "README.md", action: "upsert", content: "new text\n" }]);
  await assert.rejects(f.service.getDraftFiles({ ...actor, userId: "user-b" }, "project-a", operation.id), { code: "OPERATION_NOT_FOUND" });
});

test("changed base head, mismatched confirmation and revoked binding prevent writes", async () => {
  const f = fixture(); const operation = await f.ready();
  await assert.rejects(f.service.confirm(actor, "project-a", operation.id, "wrong-hash"), { code: "PREVIEW_CONFIRMATION_REQUIRED" });
  f.state.head.commitSha = "9".repeat(40); const result = await f.service.confirm(actor, "project-a", operation.id, operation.preview!.previewHash);
  assert.equal(result.errorCode, "BASE_HEAD_CHANGED"); assert.equal(result.status, "blocked"); assert.equal(f.state.writes.tree, 0);
  const g = fixture(); const op = await g.ready(); await g.service.unbindRepository(actor, "project-a", 1);
  await assert.rejects(g.service.confirm(actor, "project-a", op.id, op.preview!.previewHash), { code: "BINDING_CHANGED" });
});

test("concurrent confirms claim once before an external write", async () => {
  const f = fixture(); const operation = await f.ready();
  const results = await Promise.allSettled([f.service.confirm(actor, "project-a", operation.id, operation.preview!.previewHash), f.service.confirm(actor, "project-a", operation.id, operation.preview!.previewHash)]);
  assert.ok(results.some(result => result.status === "fulfilled")); assert.equal(f.state.writes.commit, 1); assert.equal(f.state.writes.branch, 1);
});

test("lost branch response remains unknown until a read verifies the exact commit; no duplicate write", async () => {
  const f = fixture(); const operation = await f.ready(); f.state.lostBranch = true;
  const unknown = await f.service.confirm(actor, "project-a", operation.id, operation.preview!.previewHash);
  assert.equal(unknown.status, "unknown"); assert.equal(f.state.drafts.size, 1);
  await assert.rejects(f.service.confirm(actor, "project-a", operation.id, operation.preview!.previewHash), { code: "PREVIEW_CONFIRMATION_REQUIRED" });
  const saved = await f.service.reconcile(actor, "project-a", operation.id); assert.equal(saved.status, "saved"); assert.equal(f.state.writes.branch, 1);
});

test("unknown commit without an acknowledged sha is not blindly recreated", async () => {
  const f = fixture(); const operation = await f.ready(); f.state.lostCommit = true;
  const result = await f.service.confirm(actor, "project-a", operation.id, operation.preview!.previewHash);
  assert.equal(result.status, "unknown"); assert.equal(result.commitSha, null);
  const reconciled = await f.service.reconcile(actor, "project-a", operation.id); assert.equal(reconciled.status, "unknown"); assert.equal(f.state.writes.commit, 1); assert.equal(f.state.writes.branch, 0);
});

test("known unreferenced commit can resume only after read reconciliation and explicit confirmation", async () => {
  const f = fixture(); const operation = await f.ready();
  f.state.afterCommit = () => { f.state.active = false; };
  const blocked = await f.service.confirm(actor, "project-a", operation.id, operation.preview!.previewHash); assert.equal(blocked.status, "blocked"); assert.equal(f.state.writes.branch, 0);
  f.state.active = true;
  // Permission was restored; reconciliation only reads the acknowledged commit before resuming.
  const ready = await f.service.reconcile(actor, "project-a", operation.id); assert.equal(ready.status, "ready_for_preview");
  const saved = await f.service.confirm(actor, "project-a", operation.id, ready.preview!.previewHash);
  assert.equal(saved.status, "saved"); assert.equal(f.state.writes.commit, 1); assert.equal(f.state.writes.branch, 1);
});

test("PR failure and permissions remain separate from saved repository status", async () => {
  const f = fixture(); const operation = await f.ready(true); f.state.prError = true;
  const result = await f.service.confirm(actor, "project-a", operation.id, operation.preview!.previewHash);
  assert.equal(result.status, "saved"); assert.equal(result.pullRequestStatus, "failed"); assert.equal(result.commitSha, commitNew);
  f.state.prError = false;
  const retry = await f.service.retryPullRequest(actor, "project-a", operation.id); assert.equal(retry.pullRequestStatus, "created"); assert.equal(f.state.writes.commit, 1);
});

test("known rejected commit resumes an acknowledged tree after permissions recover and explicit confirmation", async () => {
  const f = fixture(); const operation = await f.ready(); f.state.commitDenied = true;
  const result = await f.service.confirm(actor, "project-a", operation.id, operation.preview!.previewHash); assert.equal(result.status, "blocked"); assert.equal(result.treeSha, treeNew);
  f.state.commitDenied = false; const ready = await f.service.reconcile(actor, "project-a", operation.id); assert.equal(ready.status, "ready_for_preview");
  const saved = await f.service.confirm(actor, "project-a", operation.id, ready.preview!.previewHash); assert.equal(saved.status, "saved"); assert.equal(f.state.writes.tree, 1); assert.equal(f.state.writes.commit, 1);
});

test("an unknown PR result remains unknown after failed reads and is never blindly posted again", async () => {
  const f = fixture(); const operation = await f.ready(true); f.state.prUnknown = true;
  const result = await f.service.confirm(actor, "project-a", operation.id, operation.preview!.previewHash); assert.equal(result.status, "saved"); assert.equal(result.pullRequestStatus, "unknown");
  f.state.prLookupFails = true; const failedLookup = await f.service.retryPullRequest(actor, "project-a", operation.id); assert.equal(failedLookup.pullRequestStatus, "unknown");
  f.state.prLookupFails = false; const stillMissing = await f.service.retryPullRequest(actor, "project-a", operation.id); assert.equal(stillMissing.pullRequestStatus, "unknown"); assert.equal(f.state.writes.pr, 1);
});

test("disconnecting the binding during commit verification stops optional PR publication", async () => {
  const f = fixture(); const operation = await f.ready(true);
  f.state.onGetCommit = () => { f.store.binding = { ...f.store.binding!, status: "revoked", revision: 2 }; };
  const result = await f.service.confirm(actor, "project-a", operation.id, operation.preview!.previewHash);
  assert.equal(result.status, "saved"); assert.equal(result.pullRequestStatus, "failed"); assert.equal(result.errorCode, "BINDING_CHANGED"); assert.equal(f.state.writes.pr, 0);
});

test("a mismatched remote ref never becomes saved, and a live lease prevents premature recovery", async () => {
  const f = fixture(); const operation = await f.ready(); f.state.lostBranch = true;
  await f.service.confirm(actor, "project-a", operation.id, operation.preview!.previewHash); f.state.branch.set(operation.branch, "0".repeat(40));
  await assert.rejects(f.service.reconcile(actor, "project-a", operation.id), { code: "REMOTE_BRANCH_MISMATCH" });
  const stored = f.store.operations.get(operation.id)!; f.store.operations.set(operation.id, { ...stored, status: "saving", leaseUntil: "2026-10-08T00:05:00.000Z" });
  const stillRunning = await f.service.reconcile(actor, "project-a", operation.id); assert.equal(stillRunning.status, "saving");
});

test("expired/tampered drafts and suspect keys preserve a blocked draft and never write", async () => {
  const f = fixture(); const operation = await f.ready(); f.state.now = new Date("2026-10-09T00:00:00.000Z");
  await assert.rejects(f.service.confirm(actor, "project-a", operation.id, operation.preview!.previewHash), { code: "DRAFT_EXPIRED" });
  const g = fixture(); const op = await g.ready(); g.state.drafts.set(op.draftRef, [{ path: "README.md", action: "upsert", content: "mutated" }]);
  await assert.rejects(g.service.confirm(actor, "project-a", op.id, op.preview!.previewHash), { code: "DRAFT_CONTENT_CHANGED" });
  const h = fixture(); const blocked = await h.ready(false, [{ path: ".env", action: "upsert", content: "SOME_KEY=private" }]);
  assert.equal(blocked.status, "blocked"); assert.equal(h.state.writes.tree, 0); assert.ok(blocked.manifest.issues.some(issue => issue.severity === "blocked"));
});
