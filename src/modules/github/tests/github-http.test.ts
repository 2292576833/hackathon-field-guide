import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { GitHubHttpAdapter, GitHubHttpError, GITHUB_API_VERSION } from "../github-http.ts";
import type { RepositoryTarget, UserCredential } from "../types.ts";

const credential: UserCredential = { token: "fixture-server-token", tokenKind: "github_app_user", websiteUserId: "user-fixture", githubUserId: 7 };
const target: RepositoryTarget = { repositoryId: 42, owner: "team", name: "demo", appId: 9, installationId: 8, defaultBranch: "main" };
const headSha = "1".repeat(40), treeSha = "2".repeat(40), newSha = "3".repeat(40);
const installation = { id: 8, app_id: 9, suspended_at: null, permissions: { contents: "write", pull_requests: "write" } };
const repository = { id: 42, permissions: { push: true }, archived: false, disabled: false };
type Step = { path: string; method?: "GET" | "POST"; data?: unknown; status?: number; headers?: HeadersInit; body?: unknown; run?: (init: RequestInit) => Promise<Response> };

function mock(steps: Step[]): { fetch: typeof globalThis.fetch; done: () => void; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher: typeof globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const step = steps[calls.length - 1];
    assert.ok(step, "Unexpected request");
    assert.equal(url, `https://api.github.com${step.path}`);
    assert.equal(init.method, step.method ?? "GET");
    assert.equal(init.redirect, "error");
    assert.equal(init.cache, "no-store");
    assert.ok(init.signal instanceof AbortSignal);
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), `Bearer ${credential.token}`);
    assert.equal(headers.get("x-github-api-version"), GITHUB_API_VERSION);
    if (step.body !== undefined) assert.deepEqual(JSON.parse(String(init.body)), step.body);
    if (step.run) return step.run(init);
    return new Response(JSON.stringify(step.data ?? {}), { status: step.status ?? 200, headers: step.headers });
  };
  return { fetch: fetcher, calls, done: () => assert.equal(calls.length, steps.length) };
}
function authSteps(overrides: { installation?: unknown; allowed?: unknown; repo?: unknown } = {}): Step[] {
  return [
    { path: "/user", data: { id: 7 } },
    { path: "/user/installations?per_page=100&page=1", data: { total_count: 1, installations: [overrides.installation ?? installation] } },
    { path: "/user/installations/8/repositories?per_page=100&page=1", data: { total_count: 1, repositories: [overrides.allowed ?? repository] } },
    { path: "/repos/team/demo", data: overrides.repo ?? repository },
  ];
}
function expectCode(code: string, unknown = false): (error: unknown) => boolean {
  return (error) => { assert.ok(error instanceof GitHubHttpError); assert.equal(error.code, code); assert.equal(error.outcomeUnknown, unknown); assert.ok(!JSON.stringify(error).includes(credential.token)); return true; };
}

test("authorization intersects installation contents/PR permissions with the current user's repository push permission", async () => {
  const transport = mock(authSteps({ installation: { ...installation, permissions: { contents: "write", pull_requests: "read" } } }));
  const adapter = new GitHubHttpAdapter({ fetch: transport.fetch });
  assert.deepEqual(await adapter.authorize(credential, target), { githubUserId: 7, userCanPush: true, contentsWrite: true, pullRequestsWrite: false });
  transport.done();
  const readOnly = mock(authSteps({ repo: { ...repository, permissions: { push: false } } }));
  assert.deepEqual(await new GitHubHttpAdapter({ fetch: readOnly.fetch }).authorize(credential, target), { githubUserId: 7, userCanPush: false, contentsWrite: false, pullRequestsWrite: false });
  readOnly.done();
});

test("identity mismatch stops before installation or repository requests; installation tokens are rejected locally", async () => {
  const transport = mock([{ path: "/user", data: { id: 99, login: credential.token } }]);
  const adapter = new GitHubHttpAdapter({ fetch: transport.fetch });
  await assert.rejects(adapter.authorize(credential, target), expectCode("GITHUB_IDENTITY_MISMATCH"));
  transport.done();
  const noRequests = mock([]);
  await assert.rejects(new GitHubHttpAdapter({ fetch: noRequests.fetch }).authorize({ ...credential, tokenKind: "github_app_installation" } as unknown as UserCredential, target), expectCode("GITHUB_CREDENTIAL_INVALID"));
  noRequests.done();
});

test("wrong App, suspended installation and repository-name rebinding are denied", async () => {
  for (const value of [{ ...installation, app_id: 100 }, { ...installation, suspended_at: "2026-10-08T00:00:00Z" }]) {
    const transport = mock(authSteps({ installation: value }).slice(0, 2));
    await assert.rejects(new GitHubHttpAdapter({ fetch: transport.fetch }).authorize(credential, target), expectCode("GITHUB_INSTALLATION_REVOKED"));
    transport.done();
  }
  const transport = mock(authSteps({ repo: { ...repository, id: 43 } }));
  await assert.rejects(new GitHubHttpAdapter({ fetch: transport.fetch }).authorize(credential, target), expectCode("GITHUB_REPOSITORY_MISMATCH"));
  transport.done();
});

test("installation and repository scope pagination uses fixed-origin constructed URLs", async () => {
  const fillerInstallations = Array.from({ length: 100 }, (_, i) => ({ ...installation, id: 1000 + i }));
  const fillerRepositories = Array.from({ length: 100 }, (_, i) => ({ ...repository, id: 1000 + i }));
  const transport = mock([
    { path: "/user", data: { id: 7 } },
    { path: "/user/installations?per_page=100&page=1", data: { total_count: 101, installations: fillerInstallations }, headers: { link: '<https://untrusted.invalid/?secret>; rel="next"' } },
    { path: "/user/installations?per_page=100&page=2", data: { total_count: 101, installations: [installation] } },
    { path: "/user/installations/8/repositories?per_page=100&page=1", data: { total_count: 101, repositories: fillerRepositories } },
    { path: "/user/installations/8/repositories?per_page=100&page=2", data: { total_count: 101, repositories: [repository] } },
    { path: "/repos/team/demo", data: repository },
  ]);
  assert.equal((await new GitHubHttpAdapter({ fetch: transport.fetch }).authorize(credential, target)).contentsWrite, true);
  transport.done();
});

test("repository outside installation scope cannot reach the repository endpoint", async () => {
  const transport = mock(authSteps({ allowed: { ...repository, id: 500 } }).slice(0, 3));
  await assert.rejects(new GitHubHttpAdapter({ fetch: transport.fetch }).authorize(credential, target), expectCode("GITHUB_REPOSITORY_NOT_ALLOWED"));
  transport.done();
});

test("getHead uses exact ref and commit tree; missing ref is null and prefix match is rejected", async () => {
  const transport = mock([
    { path: "/repos/team/demo/git/ref/heads/hackathon/op1", data: { ref: "refs/heads/hackathon/op1", object: { type: "commit", sha: headSha } } },
    { path: `/repos/team/demo/git/commits/${headSha}`, data: { sha: headSha, tree: { sha: treeSha }, parents: [], message: "base" } },
  ]);
  assert.deepEqual(await new GitHubHttpAdapter({ fetch: transport.fetch }).getHead(credential, target, "hackathon/op1"), { commitSha: headSha, treeSha });
  transport.done();
  const missing = mock([{ path: "/repos/team/demo/git/ref/heads/main", status: 404 }]);
  assert.equal(await new GitHubHttpAdapter({ fetch: missing.fetch }).getHead(credential, target, "main"), null);
  missing.done();
  const wrong = mock([{ path: "/repos/team/demo/git/ref/heads/main", data: { ref: "refs/heads/main-old", object: { type: "commit", sha: headSha } } }]);
  await assert.rejects(new GitHubHttpAdapter({ fetch: wrong.fetch }).getHead(credential, target, "main"), expectCode("GITHUB_INVALID_RESPONSE"));
  wrong.done();
});

test("recursive tree truncation fails closed", async () => {
  const transport = mock([{ path: `/repos/team/demo/git/trees/${treeSha}?recursive=1`, data: { sha: treeSha, truncated: true, tree: [] } }]);
  await assert.rejects(new GitHubHttpAdapter({ fetch: transport.fetch }).getTree(credential, target, treeSha), expectCode("GITHUB_TREE_INCOMPLETE"));
  transport.done();
});

test("blob preview accepts strict bounded base64 UTF-8 and rejects binary or oversized content", async () => {
  const content = "\ufeff欢迎参赛\n";
  const bytes = Buffer.from(content, "utf8");
  const transport = mock([{ path: `/repos/team/demo/git/blobs/${headSha}`, data: { sha: headSha, encoding: "base64", content: bytes.toString("base64"), size: bytes.length } }]);
  assert.equal(await new GitHubHttpAdapter({ fetch: transport.fetch }).getBlobText(credential, target, headSha), content);
  transport.done();
  for (const [encoded, size, code] of [["/w==", 1, "GITHUB_BLOB_NOT_TEXT"], ["A===", 1, "GITHUB_INVALID_RESPONSE"], [bytes.toString("base64"), bytes.length, "GITHUB_BLOB_TOO_LARGE"]] as const) {
    const transport = mock([{ path: `/repos/team/demo/git/blobs/${headSha}`, data: { sha: headSha, encoding: "base64", content: encoded, size } }]);
    await assert.rejects(new GitHubHttpAdapter({ fetch: transport.fetch, maxBlobBytes: 4 }).getBlobText(credential, target, headSha), expectCode(code));
    transport.done();
  }
});

test("one tree preserves base_tree and deletes only explicit sha:null entries, one commit carries one base parent", async () => {
  const transport = mock([
    ...authSteps(),
    { path: "/repos/team/demo/git/trees", method: "POST", status: 201, body: { base_tree: treeSha, tree: [{ path: "README.md", mode: "100644", type: "blob", content: "new content" }, { path: "old.txt", mode: "100644", type: "blob", sha: null }] }, data: { sha: newSha } },
    ...authSteps(),
    { path: "/repos/team/demo/git/commits", method: "POST", status: 201, body: { message: "saved operation", tree: newSha, parents: [headSha] }, data: { sha: newSha } },
  ]);
  const adapter = new GitHubHttpAdapter({ fetch: transport.fetch });
  assert.equal(await adapter.createTree(credential, target, treeSha, [{ path: "README.md", action: "upsert", content: "new content" }, { path: "old.txt", action: "delete" }]), newSha);
  assert.equal(await adapter.createCommit(credential, target, { treeSha: newSha, parentSha: headSha, message: "saved operation" }), newSha);
  transport.done();
  assert.equal(transport.calls.filter((call) => call.init.method === "POST").length, 2);
});

test("each write refreshes current permission and revoked user write blocks the mutation", async () => {
  const transport = mock(authSteps({ repo: { ...repository, permissions: { push: false } } }));
  await assert.rejects(new GitHubHttpAdapter({ fetch: transport.fetch }).createBranch(credential, target, "hackathon/op1", newSha), expectCode("GITHUB_PERMISSION_DENIED"));
  transport.done();
  assert.equal(transport.calls.filter((call) => call.init.method === "POST").length, 0);
});

test("branch creation only creates a new ref and checks returned exact commit", async () => {
  const transport = mock([...authSteps(), { path: "/repos/team/demo/git/refs", method: "POST", status: 201, body: { ref: "refs/heads/hackathon/op1", sha: newSha }, data: { ref: "refs/heads/hackathon/op1", object: { type: "commit", sha: newSha } } }]);
  await new GitHubHttpAdapter({ fetch: transport.fetch }).createBranch(credential, target, "hackathon/op1", newSha);
  transport.done();
  assert.ok(transport.calls.every((call) => !["PATCH", "PUT", "DELETE"].includes(String(call.init.method))));
});

test("write network failure, timeout, 5xx and malformed success are unknown; errors never retain provider secrets", async () => {
  const scenarios: Partial<Step>[] = [
    { run: async () => { throw new Error(`provider ${credential.token}`); } },
    { run: async () => new Promise<Response>(() => {}) },
    { status: 502, data: { message: credential.token } },
    { status: 201, data: { sha: "invalid", message: credential.token } },
    { status: 202, data: { sha: newSha } },
  ];
  for (const scenario of scenarios) {
    const transport = mock([...authSteps(), { path: "/repos/team/demo/git/commits", method: "POST", ...scenario }]);
    const adapter = new GitHubHttpAdapter({ fetch: transport.fetch, timeoutMs: 20 });
    await assert.rejects(adapter.createCommit(credential, target, { treeSha, parentSha: headSha, message: "save" }), expectCode("GITHUB_OUTCOME_UNKNOWN", true));
    transport.done();
    assert.equal(transport.calls.filter((call) => call.init.method === "POST").length, 1);
  }
  const transport = mock([{ path: "/user", run: async () => { throw new Error(credential.token); } }]);
  await assert.rejects(new GitHubHttpAdapter({ fetch: transport.fetch }).authorize(credential, target), expectCode("GITHUB_SERVICE_UNAVAILABLE"));
  transport.done();
});

test("rate-limit classification preserves safe UTC retry time and never retries", async () => {
  const transport = mock([{ path: "/user", status: 403, data: { message: credential.token }, headers: { "retry-after": "30", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1791417660" } }]);
  await assert.rejects(new GitHubHttpAdapter({ fetch: transport.fetch, now: () => 1_791_417_600_000 }).authorize(credential, target), (error) => {
    expectCode("GITHUB_RATE_LIMITED")(error);
    assert.equal((error as GitHubHttpError).retryAt, "2026-10-08T00:01:00.000Z");
    assert.equal((error as GitHubHttpError).providerStatus, 403);
    return true;
  });
  transport.done();
});

test("PR reconciliation includes closed requests, paginates and compares exact head/base repository IDs", async () => {
  const wrong = { head: { ref: "hackathon/op1", repo: { id: 999 } }, base: { ref: "main", repo: { id: 42 } }, html_url: "https://github.com/team/demo/pull/1" };
  const exact = { ...wrong, state: "closed", head: { ref: "hackathon/op1", repo: { id: 42 } }, html_url: "https://github.com/team/demo/pull/2" };
  const transport = mock([
    { path: "/repos/team/demo/pulls?state=all&head=team%3Ahackathon%2Fop1&base=main&per_page=100&page=1", data: Array.from({ length: 100 }, () => wrong) },
    { path: "/repos/team/demo/pulls?state=all&head=team%3Ahackathon%2Fop1&base=main&per_page=100&page=2", data: [exact] },
  ]);
  assert.equal(await new GitHubHttpAdapter({ fetch: transport.fetch }).findPullRequest(credential, target, "hackathon/op1", "main"), "https://github.com/team/demo/pull/2");
  transport.done();
});

test("PR creation requires user/App PR write and only creates a PR with no merge action", async () => {
  const input = { head: "hackathon/op1", base: "main", title: "Review version", body: "Manual review required" };
  const transport = mock([...authSteps(), { path: "/repos/team/demo/pulls", method: "POST", status: 201, body: { ...input, maintainer_can_modify: false }, data: { html_url: "https://github.com/team/demo/pull/2" } }]);
  assert.equal(await new GitHubHttpAdapter({ fetch: transport.fetch }).createPullRequest(credential, target, input), "https://github.com/team/demo/pull/2");
  transport.done();
  const readOnly = mock(authSteps({ installation: { ...installation, permissions: { contents: "write", pull_requests: "read" } } }));
  await assert.rejects(new GitHubHttpAdapter({ fetch: readOnly.fetch }).createPullRequest(credential, target, input), expectCode("GITHUB_PERMISSION_DENIED"));
  readOnly.done();
});

test("unsafe paths, workflows and branch syntax fail before network; response size is bounded", async () => {
  const transport = mock([]);
  const adapter = new GitHubHttpAdapter({ fetch: transport.fetch });
  for (const path of ["../.env", "/abs", "C:/secret", ".git/config", ".github", ".github/workflows", ".github/workflows/ci.yml"]) {
    await assert.rejects(adapter.createTree(credential, target, treeSha, [{ path, action: "upsert", content: "hello" }]), expectCode("GITHUB_INVALID_INPUT"));
  }
  await assert.rejects(adapter.createTree(credential, target, treeSha, [{ path: "foo", action: "upsert", content: "new" }, { path: "foo-between", action: "upsert", content: "new" }, { path: "foo/bar", action: "upsert", content: "new" }]), expectCode("GITHUB_INVALID_INPUT"));
  await assert.rejects(adapter.createTree(credential, target, treeSha, [{ path: "bad.txt", action: "upsert", content: "\ud800" }]), expectCode("GITHUB_INVALID_INPUT"));
  for (const branch of ["../main", "main.lock", "main@{1}", "main?token", "main\\child"]) {
    await assert.rejects(adapter.getHead(credential, target, branch), expectCode("GITHUB_INVALID_INPUT"));
  }
  transport.done();
  const oversized = mock([{ path: "/user", data: { id: 7 }, headers: { "content-length": "9999999" } }]);
  await assert.rejects(new GitHubHttpAdapter({ fetch: oversized.fetch, maxResponseBytes: 32 }).authorize(credential, target), expectCode("GITHUB_INVALID_RESPONSE"));
  oversized.done();
});
