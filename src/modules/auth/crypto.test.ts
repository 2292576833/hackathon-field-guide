import assert from "node:assert/strict";
import test from "node:test";
import { createNodeAuthCrypto } from "./crypto.ts";

test("code digests bind both challenge and private pepper, while session digests survive pepper rotation", () => {
  const one = createNodeAuthCrypto("test-only-pepper-number-one-32bytes");
  const two = createNodeAuthCrypto("test-only-pepper-number-two-32bytes");
  assert.notEqual(one.hashCode("challenge-a", "12345678"), one.hashCode("challenge-b", "12345678"));
  assert.notEqual(one.hashCode("challenge-a", "12345678"), two.hashCode("challenge-a", "12345678"));
  assert.match(one.hashCode("challenge-a", "12345678"), /^[0-9a-f]{64}$/);
  const token = one.generateSessionToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(one.hashSessionToken(token), two.hashSessionToken(token));
  assert.notEqual(token, one.generateSessionToken());
  assert.match(one.generateCode(), /^[0-9]{8}$/);
  assert.notEqual(one.hashRateKey("send-email", "a@example.com"), one.hashRateKey("verify-client", "a@example.com"));
  assert.throws(() => createNodeAuthCrypto("too-short"));
});
