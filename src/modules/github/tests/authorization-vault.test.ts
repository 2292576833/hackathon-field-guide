import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { AesGcmCredentialCipher } from "../authorization-vault.ts";
import type { CredentialCipherOptions } from "../authorization-vault.ts";
import type { EncryptedValue, GitHubTokenSet } from "../authorization-types.ts";

const oldKey = Buffer.alloc(32, 17).toString("base64");
const newKey = Buffer.alloc(32, 29).toString("base64");
const context = JSON.stringify(["github-app-tokens", "website-user", 42, 123]);
const tokenSet: GitHubTokenSet = { accessToken: "private-access-token-for-test", refreshToken: "private-refresh-token-for-test", accessExpiresAt: "2026-10-08T12:00:00.000Z", refreshExpiresAt: "2027-04-08T12:00:00.000Z" };
function cipher() { return new AesGcmCredentialCipher({ activeKeyId: "old", keyring: { old: oldKey } }); }
function tamper(value: string): string { const data = Buffer.from(value, "base64"); data[0] ^= 1; return data.toString("base64"); }

test("AES-256-GCM round-trips independent JSON tokens using random 96-bit IV and 128-bit tag", () => {
  const vault = cipher();
  const first = vault.encrypt(tokenSet, context), second = vault.encrypt(tokenSet, context);
  assert.equal(Buffer.from(first.iv, "base64").length, 12);
  assert.equal(Buffer.from(first.tag, "base64").length, 16);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.data, second.data);
  assert.equal(first.keyId, "old");
  const roundTrip = vault.decrypt<GitHubTokenSet>(first, context);
  assert.deepEqual(roundTrip, tokenSet);
  roundTrip.accessToken = "changed";
  assert.deepEqual(vault.decrypt(first, context), tokenSet);
  assert.ok(!JSON.stringify(first).includes(tokenSet.accessToken));
  assert.ok(!JSON.stringify(first).includes(tokenSet.refreshToken));
  assert.equal(Object.keys(vault).length, 0);
});

test("ciphertext, tag, IV and key-id modifications cannot authenticate", () => {
  const vault = new AesGcmCredentialCipher({ activeKeyId: "old", keyring: { old: oldKey, alias: oldKey } });
  const sealed = vault.encrypt(tokenSet, context);
  for (const changed of [{ ...sealed, data: tamper(sealed.data) }, { ...sealed, tag: tamper(sealed.tag) }, { ...sealed, iv: tamper(sealed.iv) }, { ...sealed, keyId: "alias" }]) {
    assert.throws(() => vault.decrypt(changed, context), { code: "CREDENTIAL_CIPHER_FAILED" });
  }
});

test("AAD binds purpose, website user, App and GitHub identity without ambiguous tuple separators", () => {
  const vault = cipher(), sealed = vault.encrypt(tokenSet, context);
  for (const other of [JSON.stringify(["github-app-state", "website-user", 42, 123]), JSON.stringify(["github-app-tokens", "other-user", 42, 123]), JSON.stringify(["github-app-tokens", "website-user", 43, 123]), JSON.stringify(["github-app-tokens", "website-user", 42, 124])]) {
    assert.throws(() => vault.decrypt(sealed, other), { code: "CREDENTIAL_CIPHER_FAILED" });
  }
  const first = JSON.stringify(["github-app-tokens", "user:a", 42, 123]);
  assert.throws(() => vault.decrypt(vault.encrypt(tokenSet, first), JSON.stringify(["github-app-tokens:user", "a", 42, 123])), { code: "CREDENTIAL_CIPHER_FAILED" });
  for (const invalid of ["", "purpose\nuser", "purpose\ruser", "purpose\0user", "bad\ud800", "x".repeat(1_025)]) {
    assert.throws(() => vault.encrypt(tokenSet, invalid), { code: "CREDENTIAL_CIPHER_INPUT_INVALID" });
    assert.throws(() => vault.decrypt(sealed, invalid), { code: "CREDENTIAL_CIPHER_FAILED" });
  }
});

test("rotation decrypts retained old keys and always encrypts with the new active key", () => {
  const original = cipher().encrypt(tokenSet, context);
  const keys = { old: oldKey, current: newKey };
  const rotated = new AesGcmCredentialCipher({ activeKeyId: "current", keyring: keys });
  keys.old = newKey; // The vault copied the configuration instead of retaining this mutable object.
  assert.deepEqual(rotated.decrypt(original, context), tokenSet);
  assert.equal(rotated.encrypt(tokenSet, context).keyId, "current");
  assert.throws(() => new AesGcmCredentialCipher({ activeKeyId: "old", keyring: { old: newKey } }).decrypt(original, context), { code: "CREDENTIAL_CIPHER_FAILED" });
  assert.throws(() => new AesGcmCredentialCipher({ activeKeyId: "current", keyring: { current: newKey } }).decrypt(original, context), { code: "CREDENTIAL_CIPHER_FAILED" });
});

test("keyrings reject absent, malformed and non-256-bit keys without exposing configuration values", () => {
  const optionsList: CredentialCipherOptions[] = [{ activeKeyId: "absent", keyring: { old: oldKey } }, { activeKeyId: "old", keyring: {} }, { activeKeyId: "old\n", keyring: { old: oldKey } }, { activeKeyId: "old", keyring: { old: "secret-invalid-key-value" } }, { activeKeyId: "old", keyring: { old: Buffer.alloc(31).toString("base64") } }, { activeKeyId: "old", keyring: { old: Buffer.alloc(33).toString("base64") } }, { activeKeyId: "old", keyring: { old: oldKey.trimEnd().replace(/=$/u, "") } }];
  for (const options of optionsList) {
    assert.throws(() => new AesGcmCredentialCipher(options), error => {
      assert.equal((error as { code: string }).code, "CREDENTIAL_CIPHER_CONFIG_INVALID");
      assert.ok(!String(error).includes(oldKey));
      assert.ok(!String(error).includes("secret-invalid-key-value"));
      assert.equal((error as { cause?: unknown }).cause, undefined);
      return true;
    });
  }
});

test("64 KiB payload limit counts the serialized UTF-8 JSON including escaping", () => {
  const vault = cipher();
  const exact = "a".repeat(65_534);
  const sealed = vault.encrypt(exact, context);
  assert.equal(Buffer.from(sealed.data, "base64").length, 65_536);
  assert.equal(vault.decrypt(sealed, context), exact);
  assert.throws(() => vault.encrypt(exact + "a", context), { code: "CREDENTIAL_CIPHER_INPUT_INVALID" });
  assert.throws(() => vault.encrypt("😀".repeat(16_384), context), { code: "CREDENTIAL_CIPHER_INPUT_INVALID" });
  assert.throws(() => vault.encrypt("\0".repeat(11_000), context), { code: "CREDENTIAL_CIPHER_INPUT_INVALID" });
});

test("JSON clone validation rejects cycles, non-JSON types, unsafe prototypes and excessive nesting", () => {
  const vault = cipher();
  const circular: Record<string, unknown> = {}; circular.self = circular;
  let nested: unknown = null; for (let index = 0; index < 66; index += 1) nested = [nested];
  for (const invalid of [circular, nested, undefined, () => {}, 1n, Symbol("secret-symbol"), Number.NaN, Number.POSITIVE_INFINITY, new Date(), new Map(), new Uint8Array([1, 2]), { value: undefined }, [undefined], new Array(2), { invalid: "\ud800" }]) {
    assert.throws(() => vault.encrypt(invalid, context), { code: "CREDENTIAL_CIPHER_INPUT_INVALID" });
  }
  const nullPrototype = Object.assign(Object.create(null), { valid: [false, null, 1, "text"] });
  assert.deepEqual(vault.decrypt(vault.encrypt(nullPrototype, context), context), { valid: [false, null, 1, "text"] });
  const pollution = JSON.parse('{"__proto__":{"polluted":true}}') as unknown;
  const returned = vault.decrypt<Record<string, unknown>>(vault.encrypt(pollution, context), context);
  assert.equal(Object.prototype.hasOwnProperty.call(returned, "__proto__"), true);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test("getters, toJSON and proxy traps are not invoked for plaintext or encrypted envelopes", () => {
  const vault = cipher(); let calls = 0;
  const getter = Object.defineProperty({}, "accessToken", { enumerable: true, get() { calls += 1; return tokenSet.accessToken; } });
  const toJSON = { toJSON() { calls += 1; return tokenSet; } };
  const proxy = new Proxy({}, { ownKeys() { calls += 1; throw new Error(tokenSet.accessToken); } });
  for (const value of [getter, toJSON, proxy]) assert.throws(() => vault.encrypt(value, context), { code: "CREDENTIAL_CIPHER_INPUT_INVALID" });
  const envelopeGetter = Object.defineProperty({ ...vault.encrypt(tokenSet, context) }, "data", { enumerable: true, get() { calls += 1; return tokenSet.accessToken; } });
  assert.throws(() => vault.decrypt(envelopeGetter, context), { code: "CREDENTIAL_CIPHER_FAILED" });
  assert.throws(() => vault.decrypt(proxy as EncryptedValue, context), { code: "CREDENTIAL_CIPHER_FAILED" });
  assert.equal(calls, 0);
});

test("corrupted envelope errors contain no plaintext, key material, provider details or cause", () => {
  const vault = cipher(), sealed = vault.encrypt(tokenSet, context);
  const malformed = [{ ...sealed, data: tokenSet.accessToken }, { ...sealed, iv: "invalid" }, { ...sealed, tag: randomBytes(15).toString("base64") }, { ...sealed, data: Buffer.alloc(65_537).toString("base64") }, { ...sealed, unexpected: tokenSet.refreshToken }, { ...sealed, keyId: "unknown" }];
  for (const value of malformed) {
    assert.throws(() => vault.decrypt(value, context), error => {
      assert.equal((error as { code: string }).code, "CREDENTIAL_CIPHER_FAILED");
      for (const secret of [tokenSet.accessToken, tokenSet.refreshToken, oldKey, sealed.data]) assert.ok(!String(error).includes(secret));
      assert.equal((error as { cause?: unknown }).cause, undefined);
      return true;
    });
  }
});
