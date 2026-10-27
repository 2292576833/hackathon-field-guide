import assert from "node:assert/strict";
import test from "node:test";
import { DomainError, toErrorEnvelope } from "../../shared/errors.ts";
import { createNodeGuanchaCrypto, GuanchaLoginService } from "./index.ts";
import type { GuanchaAttemptStorePort, GuanchaIdentityPort, GuanchaProviderPort } from "./ports.ts";
import type { GuanchaLoginAttempt, GuanchaProviderConfiguration, GuanchaVerifiedIdentity } from "./types.ts";

const crypto = createNodeGuanchaCrypto("test-only-guancha-state-secret-not-for-production");
const config: GuanchaProviderConfiguration = {
  issuer: "https://provider.example.test", authorizationEndpoint: "https://provider.example.test/authorize",
  redirectUri: "https://app.example.test/auth/callback", documentationUrl: "https://provider.example.test/docs",
  configurationId: "test-v1", pkce: "S256", useNonce: true,
};
class Attempts implements GuanchaAttemptStorePort {
  readonly rows = new Map<string, GuanchaLoginAttempt>();
  readonly consumed = new Set<string>();
  async save(value: GuanchaLoginAttempt) { this.rows.set(value.stateHash, structuredClone(value)); }
  async consume(input: Parameters<GuanchaAttemptStorePort["consume"]>[0]) {
    const row = this.rows.get(input.stateHash);
    if (!row || this.consumed.has(input.stateHash) || row.browserBindingHash !== input.browserBindingHash
        || row.issuer !== input.issuer || row.configurationId !== input.configurationId || row.redirectUri !== input.redirectUri
        || row.createdAt > input.now || row.expiresAt <= input.now) return null;
    this.consumed.add(input.stateHash);
    return structuredClone(row);
  }
}
function fixture(configuration = config) {
  const attempts = new Attempts();
  let now = new Date("2026-10-12T00:00:00.000Z");
  const verified: GuanchaVerifiedIdentity = { issuer: configuration.issuer, subject: "opaque-ID-Case", displayName: "观猹用户" };
  const exchanges: Parameters<GuanchaProviderPort["exchangeAndVerify"]>[0][] = [];
  const completed: Parameters<GuanchaIdentityPort<string>["completeLogin"]>[0][] = [];
  const provider: GuanchaProviderPort = {
    configuration,
    authorizationUrl(input) {
      const url = new URL(configuration.authorizationEndpoint);
      Object.entries({ response_type: "code", client_id: "test-only-public-client", state: input.state, redirect_uri: input.redirectUri }).forEach(([key, value]) => url.searchParams.set(key, value));
      if (input.codeChallenge) { url.searchParams.set("code_challenge", input.codeChallenge); url.searchParams.set("code_challenge_method", "S256"); }
      if (input.nonce) url.searchParams.set("nonce", input.nonce);
      return url.toString();
    },
    async exchangeAndVerify(input) { exchanges.push(input); return verified; },
  };
  const deps = {
    attempts, crypto, provider, clock: { now: () => now }, safeReturnTo: (input: unknown) => input === "/events" ? "/events" : "/app",
    identity: { async completeLogin(input: Parameters<GuanchaIdentityPort<string>["completeLogin"]>[0]) { completed.push(input); return "server-only-session-grant"; } },
  };
  return { attempts, provider, verified, deps, exchanges, completed, advance: (ms: number) => { now = new Date(now.getTime() + ms); }, service: new GuanchaLoginService(deps) };
}
async function begin(f: ReturnType<typeof fixture>) {
  const started = await f.service.begin("/events");
  return { started, state: new URL(started.authorizationUrl).searchParams.get("state")!, browserBinding: started.browserBinding, code: "provider-test-code" };
}
const isCode = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;

test("unconfigured provider is disabled and does not create a state", async () => {
  const f = fixture(); const service = new GuanchaLoginService({ ...f.deps, provider: undefined });
  assert.equal(service.enabled, false);
  await assert.rejects(service.begin(), isCode("GUANCHA_LOGIN_UNAVAILABLE"));
  assert.equal(f.attempts.rows.size, 0);
});

test("state and browser binding are independent, hashed; PKCE verifier is encrypted and excluded from authorization URL", async () => {
  const f = fixture(), request = await begin(f);
  assert.notEqual(request.state, request.browserBinding);
  const row = [...f.attempts.rows.values()][0]!;
  assert.equal(row.stateHash, crypto.hash(request.state));
  assert.equal(row.browserBindingHash, crypto.hash(request.browserBinding));
  const secrets = crypto.open(row.secretCiphertext, row.stateHash);
  assert.ok(secrets.codeVerifier);
  assert.ok(!JSON.stringify(row).includes(secrets.codeVerifier));
  assert.ok(!JSON.stringify(row).includes(request.state));
  assert.ok(!JSON.stringify(row).includes(request.browserBinding));
  const url = new URL(request.started.authorizationUrl);
  assert.equal(url.searchParams.get("code_challenge"), crypto.s256(secrets.codeVerifier));
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("nonce"), secrets.nonce);
  assert.ok(!url.searchParams.has("code_verifier"));
});

test("wrong browser cannot consume state, valid callback completes once under concurrent replay", async () => {
  const f = fixture(), request = await begin(f);
  await assert.rejects(f.service.complete({ ...request, browserBinding: crypto.randomToken() }), isCode("GUANCHA_LOGIN_INVALID"));
  assert.equal(f.exchanges.length, 0);
  const result = await Promise.allSettled([f.service.complete(request), f.service.complete(request)]);
  assert.equal(result.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(f.exchanges.length, 1);
  assert.equal(f.completed.length, 1);
  assert.equal(f.completed[0]!.returnTo, "/events");
  assert.equal(f.completed[0]!.browserBindingHash, crypto.hash(request.browserBinding));
});

test("expiry and changed configuration fail before provider exchange", async () => {
  const f = fixture(), request = await begin(f);
  const changed = new GuanchaLoginService({ ...f.deps, provider: { ...f.provider, configuration: { ...config, configurationId: "test-v2" } } });
  await assert.rejects(changed.complete(request), isCode("GUANCHA_LOGIN_INVALID"));
  f.advance(10 * 60_000);
  await assert.rejects(f.service.complete(request), isCode("GUANCHA_LOGIN_INVALID"));
  assert.equal(f.exchanges.length, 0);
});

test("provider failure consumes state permanently and error output omits raw tokens and descriptions", async () => {
  const f = fixture(), request = await begin(f);
  let attempts = 0;
  f.provider.exchangeAndVerify = async () => { attempts++; throw new DomainError("PROVIDER_SECRET", "client_secret=private-test-value; code=secret-code", { status: 400 }); };
  await assert.rejects(f.service.complete(request), error => {
    const envelope = toErrorEnvelope(error, "test-request");
    assert.equal(envelope.error.code, "GUANCHA_LOGIN_UNAVAILABLE");
    assert.ok(!JSON.stringify(envelope).includes("private-test-value"));
    return true;
  });
  await assert.rejects(f.service.complete(request), isCode("GUANCHA_LOGIN_INVALID"));
  assert.equal(attempts, 1);
  assert.equal(f.completed.length, 0);
});

test("cancellation and contradictory callback consume state without exchange", async () => {
  const f = fixture(), request = await begin(f);
  await assert.rejects(f.service.complete({ ...request, code: undefined, error: "access_denied" }), isCode("GUANCHA_LOGIN_CANCELLED"));
  await assert.rejects(f.service.complete(request), isCode("GUANCHA_LOGIN_INVALID"));
  const second = await begin(f);
  await assert.rejects(f.service.complete({ ...second, error: "access_denied" }), isCode("GUANCHA_LOGIN_INVALID"));
  assert.equal(f.exchanges.length, 0);
});

test("only exact issuer and opaque subject reach root; unverified emails and roles are discarded", async () => {
  const f = fixture(), request = await begin(f);
  Object.assign(f.verified, { email: "victim@example.test", email_verified: false, userId: "victim", platformRoles: ["admin"], access_token: "secret-token" });
  await f.service.complete(request);
  assert.deepEqual(f.completed[0]!.identity, { issuer: config.issuer, subject: "opaque-ID-Case", displayName: "观猹用户" });
  const another = fixture(), next = await begin(another);
  another.provider.exchangeAndVerify = async () => ({ issuer: "https://attacker.example.test", subject: "opaque-ID-Case" });
  await assert.rejects(another.service.complete(next), isCode("GUANCHA_LOGIN_UNAVAILABLE"));
  assert.equal(another.completed.length, 0);
});

test("returned authorization URL cannot move state to another host, leak client secret, or drop PKCE", async () => {
  for (const change of [
    (url: URL) => { url.hostname = "attacker.example.test"; },
    (url: URL) => { url.searchParams.set("client_secret", "private-test-value"); },
    (url: URL) => { url.searchParams.delete("code_challenge"); },
    (url: URL) => { url.searchParams.append("state", "duplicate"); },
  ]) {
    const f = fixture(), original = f.provider.authorizationUrl;
    f.provider.authorizationUrl = input => { const url = new URL(original(input)); change(url); return url.toString(); };
    await assert.rejects(f.service.begin(), isCode("GUANCHA_LOGIN_UNAVAILABLE"));
    assert.equal(f.attempts.rows.size, 0);
  }
});

test("saved return destination rejects external input; callback cannot override it", async () => {
  const f = fixture();
  const service = new GuanchaLoginService({ ...f.deps, safeReturnTo: input => String(input) });
  for (const value of ["https://attacker.example.test", "//attacker.example.test", "/\\attacker.example.test", "/%2fattacker.example.test", "/events%0d%0aLocation:x"]) {
    const started = await service.begin(value), state = new URL(started.authorizationUrl).searchParams.get("state")!;
    await service.complete({ state, browserBinding: started.browserBinding, code: "test-code" });
    assert.equal(f.completed.at(-1)!.returnTo, "/app");
  }
});

test("documented unsupported PKCE is explicit; invalid security configuration is refused", async () => {
  const f = fixture({ ...config, pkce: "documented-unsupported", useNonce: false });
  const request = await begin(f);
  await f.service.complete(request);
  assert.equal(f.exchanges[0]!.codeVerifier, null);
  assert.equal(f.exchanges[0]!.expectedNonce, null);
  assert.throws(() => fixture({ ...config, redirectUri: "http://app.example.test/callback" }));
  assert.throws(() => fixture({ ...config, pkce: "plain" as "S256" }));
});

test("authenticated encryption detects tampering, wrong state and wrong key", () => {
  const secrets = { codeVerifier: crypto.randomToken(), nonce: crypto.randomToken() }, stateHash = crypto.hash("state");
  const sealed = crypto.seal(secrets, stateHash);
  assert.deepEqual(crypto.open(sealed, stateHash), secrets);
  assert.throws(() => crypto.open(sealed, crypto.hash("another-state")));
  const pieces = sealed.split("."); pieces[2] = (pieces[2]![0] === "A" ? "B" : "A") + pieces[2]!.slice(1);
  assert.throws(() => crypto.open(pieces.join("."), stateHash));
  assert.throws(() => createNodeGuanchaCrypto("different-test-secret-at-least-32-bytes").open(sealed, stateHash));
  assert.throws(() => createNodeGuanchaCrypto("too-short"));
});

test("slow exchange cannot extend state; known local account denial keeps 403 without forwarding details", async () => {
  const f = fixture(), request = await begin(f);
  f.provider.exchangeAndVerify = async () => { f.advance(10 * 60_000); return f.verified; };
  await assert.rejects(f.service.complete(request), isCode("GUANCHA_LOGIN_INVALID"));
  assert.equal(f.completed.length, 0);
  const denied = fixture();
  denied.deps.identity.completeLogin = async () => { throw new DomainError("GUANCHA_ACCOUNT_UNAVAILABLE", "internal secret detail", { status: 500 }); };
  await assert.rejects(denied.service.complete(await begin(denied)), error => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.status, 403);
    assert.ok(!error.message.includes("secret"));
    return true;
  });
  const spoof = fixture();
  spoof.provider.exchangeAndVerify = async () => { throw new DomainError("GUANCHA_ACCOUNT_UNAVAILABLE", "provider secret detail"); };
  await assert.rejects(spoof.service.complete(await begin(spoof)), isCode("GUANCHA_LOGIN_UNAVAILABLE"));
});
