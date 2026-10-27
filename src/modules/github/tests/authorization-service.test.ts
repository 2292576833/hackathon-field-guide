import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DomainError } from "../../../shared/errors.ts";
import type { Actor } from "../../../shared/contracts.ts";
import { GitHubAuthorizationService, authorizationCookieName } from "../authorization-service.ts";
import { AesGcmCredentialCipher } from "../authorization-vault.ts";
import { GitHubHttpError } from "../github-http.ts";
import type { AuthorizationStorePort, GitHubAuthorizationHttpPort, GitHubTokenSet, StoredAuthorizationState, StoredGitHubCredential } from "../authorization-types.ts";

const actor: Actor = { userId: "website-user-1", platformRoles: ["user"] };
const options = { appId: 31, clientId: "Iv1.client", clientSecret: "server-secret", appSlug: "hack-helper", origin: "https://local.example", callbackUrl: "https://local.example/api/v1/github/authorization/callback" };
const sha = (v: string): string => createHash("sha256").update(v).digest("hex");
const clone = <T>(v: T): T => structuredClone(v);
const conflict = (): never => { throw new DomainError("VERSION_CONFLICT", "版本冲突。", { status: 409 }); };
class Store implements AuthorizationStorePort {
  states = new Map<string, StoredAuthorizationState>(); credentials = new Map<string, StoredGitHubCredential>(); epochs = new Map<string, number>(); revoking = new Set<string>();
  key(userId: string, appId: number) { return `${userId}/${appId}`; }
  async getAuthorizationEpoch(userId: string, appId: number) { const key = this.key(userId, appId); if (this.revoking.has(key)) throw new DomainError("GITHUB_REVOCATION_IN_PROGRESS", "撤销中。", { status: 409 }); return this.epochs.get(key) ?? 0; }
  async insertState(s: StoredAuthorizationState) { if (await this.getAuthorizationEpoch(s.userId, s.appId) !== s.authorizationEpoch) throw new DomainError("AUTHORIZATION_EPOCH_CHANGED", "已撤销。"); this.states.set(s.stateHash, clone(s)); }
  async consumeState(i: Parameters<AuthorizationStorePort["consumeState"]>[0]) { const s = this.states.get(i.stateHash); if (!s || s.userId !== i.userId || s.appId !== i.appId || s.browserHash !== i.browserHash || s.flow !== i.flow || Date.parse(s.expiresAt) <= Date.parse(i.now)) return null; this.states.delete(i.stateHash); return clone(s); }
  async getCredential(userId: string, appId: number) { return clone(this.credentials.get(this.key(userId, appId)) ?? null); }
  async saveCredential(c: StoredGitHubCredential, expected: number | null, epoch?: number) { const key = this.key(c.userId, c.appId), prior = this.credentials.get(key); if (epoch !== undefined && ((this.epochs.get(key) ?? 0) !== epoch || this.revoking.has(key))) throw new DomainError("AUTHORIZATION_EPOCH_CHANGED", "已撤销。"); if (expected === null ? !!prior : prior?.revision !== expected) conflict(); this.credentials.set(key, clone(c)); }
  async revokeCredential(userId: string, appId: number, expected: number | null) { const key = this.key(userId, appId), prior = this.credentials.get(key); if (expected === null ? !!prior : prior?.revision !== expected) conflict(); const epoch = (this.epochs.get(key) ?? 0) + 1; this.epochs.set(key, epoch); this.revoking.add(key); for (const [hash, s] of this.states) if (s.userId === userId && s.appId === appId) this.states.delete(hash); if (prior) this.credentials.set(key, { ...prior, revision: prior.revision + 1, status: "revoked", encryptedTokens: null, refreshLeaseUntil: null }); return epoch; }
  async finishRevocation(userId: string, appId: number, expectedEpoch: number) { const key = this.key(userId, appId); if (this.epochs.get(key) === expectedEpoch) this.revoking.delete(key); }
  async claimRefresh(userId: string, appId: number, revision: number, leaseUntil: string) { const key = this.key(userId, appId), c = this.credentials.get(key); if (!c || c.revision !== revision || c.status !== "active") return null; const next: StoredGitHubCredential = { ...c, revision: revision + 1, status: "refreshing", refreshLeaseUntil: leaseUntil }; this.credentials.set(key, next); return clone(next); }
  async purgeExpiredStates(now: string) { let count = 0; for (const [h, s] of this.states) if (Date.parse(s.expiresAt) <= Date.parse(now)) { this.states.delete(h); count++; } return count; }
}
function fixture() {
  let now = new Date("2026-10-08T00:00:00Z"), githubId = 101, activeMember = true, serial = 0, exchangeCalls = 0, refreshCalls = 0, tokenRevokes = 0;
  const store = new Store(), cipher = new AesGcmCredentialCipher({ activeKeyId: "v1", keyring: { v1: Buffer.alloc(32, 7).toString("base64") } });
  const tokens = (): GitHubTokenSet => ({ accessToken: `ghu_${"A".repeat(30)}${++serial}`, refreshToken: `ghr_${"R".repeat(30)}${serial}`, accessExpiresAt: new Date(now.getTime() + 28_800_000).toISOString(), refreshExpiresAt: new Date(now.getTime() + 15_897_600_000).toISOString() });
  const http: GitHubAuthorizationHttpPort = {
    exchangeCode: async () => { exchangeCalls++; return tokens(); }, refreshToken: async () => { refreshCalls++; return tokens(); }, revokeGrant: async () => {}, revokeToken: async () => { tokenRevokes++; },
    getIdentity: async () => ({ id: githubId, login: "octocat", profileUrl: "https://github.com/octocat" }),
    listInstallations: async () => [{ id: 42, appId: 31, accountLogin: "octocat", accountType: "User", repositorySelection: "selected", permissions: { contents: "write" }, suspended: false }, { id: 43, appId: 99, accountLogin: "other", accountType: "Organization", repositorySelection: "all", permissions: {} as Record<string, string>, suspended: false }],
    listRepositories: async (_token, installation) => [{ repositoryId: 55, owner: "octocat", name: "demo", installationId: installation.id, appId: installation.appId, defaultBranch: "main", url: "https://github.com/octocat/demo", private: true, userCanPush: true, contentsWrite: true, pullRequestsWrite: false, archived: false, disabled: false }],
    getRepository: async () => null, createRepository: async () => { throw new Error("not part of authorization"); },
  };
  const service = new GitHubAuthorizationService({ options, store, cipher, http, access: { getMembership: async (projectId, userId) => activeMember ? { membershipId: "member", projectId, userId, role: "member", status: "active" } : null }, clock: { now: () => now }, ids: { next: () => "unused-id" } });
  const flow = async () => { const s = await service.start(actor, { projectId: "p1" }); return { ...s, state: new URL(s.authorizationUrl).searchParams.get("state")! }; };
  const bind = async () => { const s = await flow(); return service.complete(actor, { state: s.state, code: "code" }, s.cookie.value); };
  return { service, store, cipher, http, flow, bind, tokens, now: () => now, advance: (ms: number) => { now = new Date(now.getTime() + ms); }, identity: (id: number) => { githubId = id; }, membership: (v: boolean) => { activeMember = v; }, calls: () => ({ exchangeCalls, refreshCalls, tokenRevokes }) };
}
const rejects = (p: Promise<unknown>, code: string) => assert.rejects(p, (e: unknown) => e instanceof DomainError && e.code === code);
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

test("start stores only hashes/encrypted verifier and builds S256 offline_access flow", async () => {
  const f = fixture(), s = await f.flow(), u = new URL(s.authorizationUrl), row = [...f.store.states.values()][0];
  assert.equal(u.origin, "https://github.com"); assert.equal(u.searchParams.get("scope"), "offline_access"); assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(row.stateHash, sha(s.state)); assert.equal(row.browserHash, sha(s.cookie.value)); assert.equal(row.userId, actor.userId); assert.equal(row.flow, "authorization");
  const { verifier } = f.cipher.decrypt<{ verifier: string }>(row.encryptedVerifier, JSON.stringify(["github-app-state", actor.userId, 31, row.stateHash]));
  assert.equal(u.searchParams.get("code_challenge"), createHash("sha256").update(verifier).digest("base64url"));
  assert.equal(s.cookie.name, authorizationCookieName("authorization", s.state)); assert.equal(s.cookie.secure, true); assert.equal(s.cookie.maxAge, 600);
  assert.ok(!JSON.stringify(row).includes(s.cookie.value)); assert.ok(!JSON.stringify(row).includes(verifier));
});
test("callback checks actor/browser without consuming rightful state, then consumes once", async () => {
  const f = fixture(), s = await f.flow();
  await rejects(f.service.complete({ ...actor, userId: "other" }, { state: s.state, code: "code" }, s.cookie.value), "GITHUB_AUTHORIZATION_STATE_INVALID");
  await rejects(f.service.complete(actor, { state: s.state, code: "code" }, "X".repeat(43)), "GITHUB_AUTHORIZATION_STATE_INVALID");
  assert.equal(f.store.states.size, 1); const result = await f.service.complete(actor, { state: s.state, code: "code" }, s.cookie.value);
  assert.equal(result.returnTo, "/app/projects/p1/delivery"); assert.equal(f.store.states.size, 0);
  await rejects(f.service.complete(actor, { state: s.state, code: "code" }, s.cookie.value), "GITHUB_AUTHORIZATION_STATE_INVALID"); assert.equal(f.calls().exchangeCalls, 1);
  assert.ok(!JSON.stringify(result).includes("ghu_")); assert.ok(!JSON.stringify(await f.service.status(actor)).includes("ghr_"));
});
test("expiry boundary and cancellation never exchange a code", async () => {
  const f = fixture(), s = await f.flow(); f.advance(600_000);
  await rejects(f.service.complete(actor, { state: s.state, code: "code" }, s.cookie.value), "GITHUB_AUTHORIZATION_STATE_INVALID");
  const fresh = await f.flow(); await rejects(f.service.complete(actor, { state: fresh.state, error: "access_denied_secret" }, fresh.cookie.value), "GITHUB_AUTHORIZATION_CANCELLED");
  assert.equal(f.calls().exchangeCalls, 0); assert.equal(f.store.states.size, 1);
});
test("project context is checked at start and callback", async () => {
  const f = fixture(), s = await f.flow(); f.membership(false);
  await rejects(f.service.start(actor, { projectId: "p1" }), "PROJECT_NOT_FOUND");
  await rejects(f.service.complete(actor, { state: s.state, code: "code" }, s.cookie.value), "PROJECT_NOT_FOUND"); assert.equal(f.calls().exchangeCalls, 0);
});
test("identity switch requires revoke and cleans only newly minted token", async () => {
  const f = fixture(); await f.bind(); f.identity(202); const s = await f.flow();
  await rejects(f.service.complete(actor, { state: s.state, code: "code" }, s.cookie.value), "GITHUB_IDENTITY_MISMATCH");
  assert.equal((await f.store.getCredential(actor.userId, 31))?.githubUserId, 101); assert.equal(f.calls().tokenRevokes, 1);
  await f.service.revoke(actor); await f.bind(); assert.equal((await f.store.getCredential(actor.userId, 31))?.githubUserId, 202);
});
test("credential port returns server-only App token and checks live identity/App", async () => {
  const f = fixture(); await f.bind(); const c = await f.service.getAuthorizationCredential(actor);
  assert.equal(c.websiteUserId, actor.userId); assert.equal(c.githubUserId, 101); assert.equal(c.tokenKind, "github_app_user");
  await rejects(f.service.getUserCredential(actor, { repositoryId: 1, owner: "octocat", name: "demo", installationId: 42, appId: 99, defaultBranch: "main" }), "GITHUB_APP_MISMATCH");
  f.identity(202); await rejects(f.service.getAuthorizationCredential(actor), "GITHUB_IDENTITY_MISMATCH"); assert.equal((await f.store.getCredential(actor.userId, 31))?.status, "reauthorize_required");
});
test("near-expiry refresh rotates once; concurrent caller never repeats refresh", async () => {
  const f = fixture(); await f.bind(); f.advance(28_750_000);
  const held = deferred<GitHubTokenSet>(), entered = deferred<boolean>(); f.http.refreshToken = async () => { entered.resolve(true); return held.promise; };
  const first = f.service.getAuthorizationCredential(actor); await entered.promise;
  await rejects(f.service.getAuthorizationCredential(actor), "GITHUB_REFRESH_IN_PROGRESS"); held.resolve(f.tokens());
  const credential = await first, stored = await f.store.getCredential(actor.userId, 31); assert.equal(stored?.status, "active"); assert.equal(stored?.revision, 3); assert.ok(credential.token.endsWith("2"));
  assert.equal((await f.service.getAuthorizationCredential(actor)).token, credential.token);
});
test("refresh uncertainty erases credentials and cannot retry single-use refresh", async () => {
  const f = fixture(); await f.bind(); f.advance(28_750_000); let count = 0;
  f.http.refreshToken = async () => { count++; throw new Error("upstream includes secret"); };
  await rejects(f.service.getAuthorizationCredential(actor), "GITHUB_AUTHORIZATION_REQUIRED");
  await rejects(f.service.getAuthorizationCredential(actor), "GITHUB_AUTHORIZATION_REQUIRED"); const stored = await f.store.getCredential(actor.userId, 31);
  assert.equal(count, 1); assert.equal(stored?.status, "reauthorize_required"); assert.equal(stored?.encryptedTokens, null);
});
test("expired refresh lease is not reclaimed or reused", async () => {
  const f = fixture(); await f.bind(); await f.store.claimRefresh(actor.userId, 31, 1, f.now().toISOString());
  await rejects(f.service.getAuthorizationCredential(actor), "GITHUB_AUTHORIZATION_REQUIRED"); assert.equal(f.calls().refreshCalls, 0); assert.equal((await f.store.getCredential(actor.userId, 31))?.encryptedTokens, null);
});
test("expired refresh token blocks refresh", async () => {
  const f = fixture(); await f.bind(); f.advance(15_897_600_000);
  await rejects(f.service.getAuthorizationCredential(actor), "GITHUB_AUTHORIZATION_REQUIRED"); assert.equal(f.calls().refreshCalls, 0);
});
test("local revoke commits before remote uncertainty and clears pending states", async () => {
  const f = fixture(); await f.bind(); await f.flow(); f.http.revokeGrant = async () => { assert.equal((await f.store.getCredential(actor.userId, 31))?.status, "revoked"); assert.equal(f.store.states.size, 0); throw new Error("network"); };
  assert.deepEqual(await f.service.revoke(actor), { status: "revoked", remoteStatus: "unknown" }); await rejects(f.service.getAuthorizationCredential(actor), "GITHUB_AUTHORIZATION_REQUIRED");
});
test("revoke during first callback prevents late bind via epoch guard", async () => {
  const f = fixture(), s = await f.flow(), held = deferred<GitHubTokenSet>(), entered = deferred<boolean>();
  f.http.exchangeCode = async () => { entered.resolve(true); return held.promise; };
  const callback = f.service.complete(actor, { state: s.state, code: "code" }, s.cookie.value); await entered.promise; await f.service.revoke(actor); held.resolve(f.tokens());
  await rejects(callback, "AUTHORIZATION_EPOCH_CHANGED"); assert.equal(await f.store.getCredential(actor.userId, 31), null); assert.equal(f.calls().tokenRevokes, 1);
});
test("remote revoke in progress blocks new authorization flows", async () => {
  const f = fixture(); await f.bind(); const held = deferred<void>(), entered = deferred<boolean>();
  f.http.revokeGrant = async () => { entered.resolve(true); await held.promise; };
  const revoking = f.service.revoke(actor); await entered.promise;
  await rejects(f.service.start(actor), "GITHUB_REVOCATION_IN_PROGRESS"); held.resolve(); await revoking;
  await f.bind(); assert.equal((await f.service.status(actor)).status, "bound");
});
test("remote revoke uncertainty remains explicit; later invalid token cannot authorize writes", async () => {
  const f = fixture(); await f.bind(); f.http.revokeGrant = async () => { throw new GitHubHttpError("GITHUB_OUTCOME_UNKNOWN", "结果未知。", { outcomeUnknown: true }); };
  assert.equal((await f.service.revoke(actor)).remoteStatus, "unknown"); await f.bind();
  // A timed-out grant deletion may arrive late. Binding is a local record; every credential read verifies /user.
  f.http.getIdentity = async () => { throw new GitHubHttpError("GITHUB_AUTHORIZATION_REQUIRED", "授权已失效。", { providerStatus: 401, status: 401 }); };
  await rejects(f.service.getAuthorizationCredential(actor), "GITHUB_AUTHORIZATION_REQUIRED"); assert.equal((await f.service.status(actor)).status, "reauthorize_required");
});
test("revoke during refresh prevents credential reactivation", async () => {
  const f = fixture(); await f.bind(); f.advance(28_750_000); const held = deferred<GitHubTokenSet>(), entered = deferred<boolean>();
  f.http.refreshToken = async () => { entered.resolve(true); return held.promise; };
  const refreshing = f.service.getAuthorizationCredential(actor); await entered.promise; await f.service.revoke(actor); held.resolve(f.tokens());
  await rejects(refreshing, "GITHUB_AUTHORIZATION_REQUIRED"); assert.equal((await f.store.getCredential(actor.userId, 31))?.status, "revoked"); assert.equal(f.calls().tokenRevokes, 1);
});
test("concurrent callbacks CAS ensures one wins and discarded token is cleaned", async () => {
  const f = fixture(), a = await f.flow(), b = await f.flow(), entered = deferred<boolean>(), held = deferred<GitHubTokenSet>(); let count = 0;
  f.http.exchangeCode = async () => { if (++count === 1) { entered.resolve(true); return held.promise; } return f.tokens(); };
  const first = f.service.complete(actor, { state: a.state, code: "a" }, a.cookie.value); await entered.promise;
  await f.service.complete(actor, { state: b.state, code: "b" }, b.cookie.value); held.resolve(f.tokens()); await rejects(first, "VERSION_CONFLICT"); assert.equal(f.calls().tokenRevokes, 1);
});
test("installation callback binds purpose and verifies actual current-user App installation", async () => {
  const f = fixture(); await f.bind(); const s = await f.service.startInstallation(actor), state = new URL(s.installationUrl).searchParams.get("state")!;
  await rejects(f.service.complete(actor, { state, code: "code" }, s.cookie.value), "GITHUB_AUTHORIZATION_STATE_INVALID"); assert.equal(f.store.states.size, 1);
  assert.deepEqual(await f.service.completeInstallation(actor, { state, installationId: 42 }, s.cookie.value), { returnTo: "/app/account", installationId: 42 });
  const invalid = await f.service.startInstallation(actor), invalidState = new URL(invalid.installationUrl).searchParams.get("state")!;
  await rejects(f.service.completeInstallation(actor, { state: invalidState, installationId: 43 }, invalid.cookie.value), "GITHUB_INSTALLATION_NOT_ACCESSIBLE");
});
test("discovery rejects arbitrary installation and filters other Apps", async () => {
  const f = fixture(); await f.bind(); assert.equal((await f.service.listInstallations(actor)).length, 1);
  await rejects(f.service.listRepositories(actor, 43), "GITHUB_INSTALLATION_NOT_ACCESSIBLE"); await rejects(f.service.listRepositories(actor, 999), "GITHUB_INSTALLATION_NOT_ACCESSIBLE");
  assert.equal((await f.service.listRepositories(actor, 42))[0].repositoryId, 55);
});
test("unsafe config and supplied identity fields are rejected", async () => {
  const f = fixture(); await rejects(f.service.start(actor, { userId: "forged" } as never), "INVALID_INPUT");
  assert.throws(() => authorizationCookieName("authorization", "bad"), (e: unknown) => e instanceof DomainError);
});
